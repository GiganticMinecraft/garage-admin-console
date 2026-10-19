package main

import (
	"archive/zip"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	"github.com/go-chi/chi/v5"
)

// objectEntry represents a single object in the list response.
type objectEntry struct {
	Key          string    `json:"key"`
	Size         int64     `json:"size"`
	LastModified time.Time `json:"lastModified"`
}

// objectListResponse is the structured response for list objects.
type objectListResponse struct {
	Objects               []objectEntry `json:"objects"`
	Prefixes              []string      `json:"prefixes"`
	IsTruncated           bool          `json:"isTruncated"`
	NextContinuationToken string        `json:"nextContinuationToken,omitempty"`
}

// handleListObjects handles GET /api/objects/{bucket}/list?prefix=&delimiter=&continuation-token=.
// It calls S3 ListObjectsV2 and returns a single page of results.
func handleListObjects(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")
		prefix := r.URL.Query().Get("prefix")
		delimiter := r.URL.Query().Get("delimiter")
		continuationToken := r.URL.Query().Get("continuation-token")

		input := &s3.ListObjectsV2Input{
			Bucket: aws.String(bucket),
		}
		if prefix != "" {
			input.Prefix = aws.String(prefix)
		}
		if delimiter == "" {
			delimiter = "/"
		}
		input.Delimiter = aws.String(delimiter)
		if continuationToken != "" {
			input.ContinuationToken = aws.String(continuationToken)
		}

		// Non-streaming call: bound the whole exchange, since the client no
		// longer carries a global timeout (see newS3SDKClient).
		ctx, cancel := context.WithTimeout(r.Context(), nonStreamingS3Timeout)
		defer cancel()
		page, err := s3Client.client.ListObjectsV2(ctx, input)
		if err != nil {
			slog.ErrorContext(r.Context(), "s3 ListObjectsV2 failed", "bucket", bucket, "error", err)
			writeS3Error(w, err, "failed to list objects")
			return
		}

		objects := make([]objectEntry, 0, len(page.Contents))
		for _, obj := range page.Contents {
			entry := objectEntry{
				Key:  aws.ToString(obj.Key),
				Size: aws.ToInt64(obj.Size),
			}
			if obj.LastModified != nil {
				entry.LastModified = *obj.LastModified
			}
			objects = append(objects, entry)
		}

		prefixes := make([]string, 0, len(page.CommonPrefixes))
		for _, p := range page.CommonPrefixes {
			prefixes = append(prefixes, aws.ToString(p.Prefix))
		}

		resp := objectListResponse{
			Objects:     objects,
			Prefixes:    prefixes,
			IsTruncated: aws.ToBool(page.IsTruncated),
		}
		if page.NextContinuationToken != nil {
			resp.NextContinuationToken = *page.NextContinuationToken
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.ErrorContext(r.Context(), "failed to encode object list", "error", err)
		}
	}
}

// handleDownloadObject handles GET /api/objects/{bucket}/download?key=.
// It calls S3 GetObject and streams the response with Content-Disposition: attachment.
func handleDownloadObject(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")
		key := r.URL.Query().Get("key")
		if key == "" {
			writeJSONError(w, http.StatusBadRequest, "key parameter is required", "")
			return
		}

		output, err := s3Client.client.GetObject(r.Context(), &s3.GetObjectInput{
			Bucket: aws.String(bucket),
			Key:    aws.String(key),
		})
		if err != nil {
			slog.ErrorContext(r.Context(), "s3 GetObject failed", "bucket", bucket, "key", key, "error", err)
			writeS3Error(w, err, "failed to get object")
			return
		}
		defer output.Body.Close()

		w.Header().Set("Content-Disposition", attachmentDisposition(path.Base(key)))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if output.ContentType != nil {
			w.Header().Set("Content-Type", *output.ContentType)
		} else {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		if output.ContentLength != nil {
			w.Header().Set("Content-Length", fmt.Sprintf("%d", *output.ContentLength))
		}

		if _, err := io.Copy(w, output.Body); err != nil {
			slog.ErrorContext(r.Context(), "failed to stream object", "bucket", bucket, "key", key, "error", err)
		}
	}
}

// batchDownloadRequest is the JSON body for batch download.
type batchDownloadRequest struct {
	Keys []string `json:"keys"`
	// Name is an optional human-readable bucket name (alias) used for the
	// ZIP filename; falls back to the bucket path parameter (usually the ID).
	Name string `json:"name"`
}

// nonStreamingS3Timeout bounds S3 calls whose response is small and fully
// buffered (list, delete). Streaming transfers are governed by the request
// context instead.
const nonStreamingS3Timeout = 30 * time.Second

// zipFilename builds the download filename for a batch ZIP. The alias is
// preferred over the 64-hex bucket ID when the client supplies one. The name
// is caller-controlled, so path separators are stripped and it is capped.
func zipFilename(bucket, name string) string {
	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, name)
	if len(name) > 128 {
		name = name[:128]
	}
	if name == "" || name == "." || name == ".." {
		name = bucket
	}
	return name + "-files.zip"
}

// rfc8187Escape percent-encodes everything outside RFC 8187 attr-char, which
// is stricter than url.PathEscape (that leaves '=', ':' and '@' alone).
func rfc8187Escape(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '!', c == '#', c == '$', c == '&', c == '+', c == '-', c == '.',
			c == '^', c == '_', c == '`', c == '|', c == '~':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}

// attachmentDisposition builds a Content-Disposition header that is safe for
// arbitrary object names. Quotes and control characters are stripped from the
// ASCII fallback, and the UTF-8 name is carried in the RFC 6266 / RFC 8187
// filename* parameter so browsers keep Japanese and other non-ASCII names.
func attachmentDisposition(name string) string {
	if name == "" || name == "." || name == "/" {
		name = "download"
	}
	ascii := make([]byte, 0, len(name))
	for _, r := range name {
		switch {
		case r == '"' || r == '\\':
			ascii = append(ascii, '_')
		case r < 0x20 || r == 0x7f:
			// drop control characters
		case r > 0x7e:
			ascii = append(ascii, '_')
		default:
			ascii = append(ascii, byte(r))
		}
	}
	fallback := string(ascii)
	if fallback == "" {
		fallback = "download"
	}
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, fallback, rfc8187Escape(name))
}

// ---------------------------------------------------------------------------
// Error responses
// ---------------------------------------------------------------------------

// apiErrorBody is the JSON shape of every error this file returns. It is
// always built with json.Marshal so quotes or newlines in upstream messages
// cannot break the JSON.
type apiErrorBody struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

// writeJSONError writes {"error": msg, "code": code} with the given status.
func writeJSONError(w http.ResponseWriter, status int, msg, code string) {
	body, err := json.Marshal(apiErrorBody{Error: msg, Code: code})
	if err != nil {
		body = []byte(`{"error":"internal error"}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// s3ErrorStatus maps an S3 SDK error to the HTTP status the console should
// answer with, plus the S3 error code when the error came from the API.
// Missing objects/buckets are 404 and permission problems 403; anything else
// (network errors, 5xx from Garage, unknown codes) is a bad gateway.
func s3ErrorStatus(err error) (int, string) {
	var apiErr smithy.APIError
	if !errors.As(err, &apiErr) {
		return http.StatusBadGateway, ""
	}
	code := apiErr.ErrorCode()
	switch code {
	case "NoSuchKey", "NoSuchBucket", "NotFound", "NoSuchUpload":
		return http.StatusNotFound, code
	case "AccessDenied", "Forbidden":
		return http.StatusForbidden, code
	}
	return http.StatusBadGateway, code
}

// writeS3Error writes an S3 failure using s3ErrorStatus. action is a short
// prefix such as "failed to list objects".
func writeS3Error(w http.ResponseWriter, err error, action string) {
	status, code := s3ErrorStatus(err)
	writeJSONError(w, status, action+": "+err.Error(), code)
}

// isNotFound reports whether err is an S3 "object/bucket does not exist" error.
func isNotFound(err error) bool {
	status, _ := s3ErrorStatus(err)
	return status == http.StatusNotFound
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

// maxObjectKeyBytes is S3's limit on key length.
const maxObjectKeyBytes = 1024

// objectExists checks whether key already exists in bucket via HeadObject.
func objectExists(ctx context.Context, s3Client *S3Client, bucket, key string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, nonStreamingS3Timeout)
	defer cancel()
	_, err := s3Client.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err == nil {
		return true, nil
	}
	if isNotFound(err) {
		return false, nil
	}
	return false, err
}

// handleUploadObject handles POST /api/objects/{bucket}/upload[?key=&overwrite=false].
//
// The multipart body is streamed straight into S3 with the multipart-upload
// manager: nothing is buffered to temp files (the container runs with a
// read-only root filesystem) and only a few parts are held in memory. The
// whole request is capped by GARAGE_MAX_UPLOAD_BYTES.
//
// The object key comes from the "key" query parameter, else a "key" form
// field sent before the file part, else the file name. With overwrite=false
// an existing key is rejected with 409 before any data is written; when the
// key is in the query string that check happens before the body is read.
func handleUploadObject(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")
		q := r.URL.Query()
		overwrite := q.Get("overwrite") != "false"
		key := q.Get("key")
		limit := s3Client.uploadLimit()

		if r.ContentLength > limit {
			writeJSONError(w, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("upload exceeds the limit of %d bytes", limit), "EntityTooLarge")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, limit)

		checkOverwrite := func(key string) bool {
			if overwrite {
				return true
			}
			exists, err := objectExists(r.Context(), s3Client, bucket, key)
			if err != nil {
				slog.ErrorContext(r.Context(), "s3 HeadObject failed", "bucket", bucket, "key", key, "error", err)
				writeS3Error(w, err, "failed to check existing object")
				return false
			}
			if exists {
				writeJSONError(w, http.StatusConflict, "object already exists: "+key, "ObjectAlreadyExists")
				return false
			}
			return true
		}

		if len(key) > maxObjectKeyBytes {
			writeJSONError(w, http.StatusBadRequest, "key is too long", "")
			return
		}
		keyChecked := false
		if key != "" {
			if !checkOverwrite(key) {
				return
			}
			keyChecked = true
		}

		mr, err := r.MultipartReader()
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "expected a multipart/form-data body: "+err.Error(), "")
			return
		}

		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				writeJSONError(w, http.StatusBadRequest, "file field is required", "")
				return
			}
			if err != nil {
				writeUploadReadError(w, err, limit)
				return
			}

			switch part.FormName() {
			case "key":
				b, err := io.ReadAll(io.LimitReader(part, maxObjectKeyBytes+1))
				if err != nil {
					writeUploadReadError(w, err, limit)
					return
				}
				if len(b) > maxObjectKeyBytes {
					writeJSONError(w, http.StatusBadRequest, "key is too long", "")
					return
				}
				if key == "" {
					key = string(b)
				}
			case "file":
				if key == "" {
					key = part.FileName()
				}
				if key == "" {
					writeJSONError(w, http.StatusBadRequest, "key or file name is required", "")
					return
				}
				if !keyChecked && !checkOverwrite(key) {
					return
				}

				input := &s3.PutObjectInput{
					Bucket: aws.String(bucket),
					Key:    aws.String(key),
					Body:   part,
				}
				if ct := part.Header.Get("Content-Type"); ct != "" {
					input.ContentType = aws.String(ct)
				}
				uploader := manager.NewUploader(s3Client.client, func(u *manager.Uploader) {
					// Keep the configured cap within the 10,000-part limit;
					// never go below the S3 minimum part size.
					u.PartSize = max(limit/int64(manager.MaxUploadParts)+1, manager.MinUploadPartSize)
				})
				if _, err := uploader.Upload(r.Context(), input); err != nil {
					slog.ErrorContext(r.Context(), "s3 upload failed", "bucket", bucket, "key", key, "error", err)
					var maxErr *http.MaxBytesError
					if errors.As(err, &maxErr) {
						writeUploadReadError(w, maxErr, limit)
						return
					}
					writeS3Error(w, err, "failed to upload object")
					return
				}
				invalidateListCaches() // object count / usage changed

				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				_ = json.NewEncoder(w).Encode(map[string]string{
					"bucket": bucket,
					"key":    key,
				})
				return
			}
			part.Close()
		}
	}
}

// writeUploadReadError reports a failure reading the request body: 413 when
// the size cap was hit, 400 for a malformed multipart stream.
func writeUploadReadError(w http.ResponseWriter, err error, limit int64) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		writeJSONError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("upload exceeds the limit of %d bytes", limit), "EntityTooLarge")
		return
	}
	writeJSONError(w, http.StatusBadRequest, "failed to read multipart body: "+err.Error(), "")
}

// ---------------------------------------------------------------------------
// Batch ZIP download
// ---------------------------------------------------------------------------

// maxBatchDownloadKeys caps how many objects one ZIP may contain.
const maxBatchDownloadKeys = 1000

// zipErrorsEntry is the archive entry listing objects that could not be
// included.
const zipErrorsEntry = "_errors.txt"

// sanitizeZipEntryName turns an S3 key into a ZIP entry name that cannot
// escape the extraction directory (Zip Slip): backslashes become separators,
// empty, "." and ".." segments and control characters are dropped, and a
// Windows drive prefix such as "C:" is neutralised. A trailing "/" (folder
// marker object) is kept so it becomes a directory entry. Returns "" when
// nothing usable is left.
func sanitizeZipEntryName(key string) string {
	key = strings.ReplaceAll(key, "\\", "/")
	isDir := strings.HasSuffix(key, "/")
	segs := strings.Split(key, "/")
	out := make([]string, 0, len(segs))
	for _, seg := range segs {
		seg = strings.Map(func(r rune) rune {
			if r < 0x20 || r == 0x7f {
				return -1
			}
			return r
		}, seg)
		if seg == "" || seg == "." || seg == ".." {
			continue
		}
		out = append(out, seg)
	}
	if len(out) == 0 {
		return ""
	}
	if first := out[0]; len(first) >= 2 && first[1] == ':' &&
		((first[0] >= 'A' && first[0] <= 'Z') || (first[0] >= 'a' && first[0] <= 'z')) {
		out[0] = first[:1] + "_" + first[2:]
	}
	name := strings.Join(out, "/")
	if isDir {
		name += "/"
	}
	return name
}

// zipNamer hands out unique entry names, suffixing " (n)" before the
// extension on collisions (two keys that sanitize to the same name, or a
// real object called _errors.txt).
type zipNamer struct {
	used map[string]struct{}
}

func newZipNamer() *zipNamer {
	return &zipNamer{used: make(map[string]struct{})}
}

// claimDir registers a directory entry and reports whether it is new;
// duplicate directory entries are simply skipped.
func (n *zipNamer) claimDir(name string) bool {
	if _, ok := n.used[name]; ok {
		return false
	}
	n.used[name] = struct{}{}
	return true
}

// unique returns name, or name with " (n)" inserted before its extension if
// it was already handed out.
func (n *zipNamer) unique(name string) string {
	if _, ok := n.used[name]; !ok {
		n.used[name] = struct{}{}
		return name
	}
	dir, base := path.Split(name)
	ext := path.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	if stem == "" { // dotfile such as ".env": treat the whole name as the stem
		stem, ext = base, ""
	}
	for i := 1; ; i++ {
		cand := fmt.Sprintf("%s%s (%d)%s", dir, stem, i, ext)
		if _, ok := n.used[cand]; !ok {
			n.used[cand] = struct{}{}
			return cand
		}
	}
}

// precompressedExts are stored rather than deflated: compressing them again
// only burns CPU.
var precompressedExts = map[string]struct{}{
	".zip": {}, ".gz": {}, ".tgz": {}, ".bz2": {}, ".xz": {}, ".zst": {}, ".lz4": {},
	".7z": {}, ".rar": {}, ".br": {}, ".jar": {}, ".mca": {},
	".jpg": {}, ".jpeg": {}, ".png": {}, ".gif": {}, ".webp": {}, ".avif": {},
	".mp3": {}, ".ogg": {}, ".mp4": {}, ".mkv": {}, ".webm": {},
}

func zipMethodFor(name string) uint16 {
	if _, ok := precompressedExts[strings.ToLower(path.Ext(name))]; ok {
		return zip.Store
	}
	return zip.Deflate
}

// trackingWriter remembers the first write error so streamBatchZip can tell
// a broken client connection apart from an S3 read failure.
type trackingWriter struct {
	w   io.Writer
	err error
}

func (t *trackingWriter) Write(p []byte) (int, error) {
	if t.err != nil {
		return 0, t.err
	}
	n, err := t.w.Write(p)
	if err != nil {
		t.err = err
	}
	return n, err
}

// streamBatchZip writes a ZIP archive of the given objects to w. Objects that
// cannot be fetched (or break off mid-stream) are listed in _errors.txt at
// the end of the archive instead of being silently skipped. It stops early
// only when the client goes away.
func streamBatchZip(ctx context.Context, s3Client *S3Client, bucket string, keys []string, w io.Writer) {
	tw := &trackingWriter{w: w}
	zw := zip.NewWriter(tw)
	namer := newZipNamer()
	var failures []string

	for _, key := range keys {
		if ctx.Err() != nil || tw.err != nil {
			return
		}
		name := sanitizeZipEntryName(key)
		if strings.HasSuffix(name, "/") {
			if namer.claimDir(name) {
				if _, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store}); err != nil {
					return
				}
			}
			continue
		}
		if name == "" {
			name = "unnamed"
		}

		output, err := s3Client.client.GetObject(ctx, &s3.GetObjectInput{
			Bucket: aws.String(bucket),
			Key:    aws.String(key),
		})
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.ErrorContext(ctx, "s3 GetObject failed for batch download", "bucket", bucket, "key", key, "error", err)
			failures = append(failures, fmt.Sprintf("%s\t%v", key, err))
			continue
		}

		hdr := &zip.FileHeader{Name: namer.unique(name), Method: zipMethodFor(name)}
		if output.LastModified != nil {
			hdr.Modified = *output.LastModified
		}
		fw, err := zw.CreateHeader(hdr)
		if err != nil {
			output.Body.Close()
			return
		}
		_, err = io.Copy(fw, output.Body)
		output.Body.Close()
		if err != nil {
			if ctx.Err() != nil || tw.err != nil {
				return
			}
			slog.ErrorContext(ctx, "failed to copy object to zip", "bucket", bucket, "key", key, "error", err)
			failures = append(failures, fmt.Sprintf("%s\t(truncated) %v", key, err))
		}
	}

	if len(failures) > 0 {
		fw, err := zw.CreateHeader(&zip.FileHeader{
			Name:     namer.unique(zipErrorsEntry),
			Method:   zip.Deflate,
			Modified: time.Now(),
		})
		if err != nil {
			return
		}
		fmt.Fprintf(fw, "%d object(s) could not be added to this archive:\n\n%s\n", len(failures), strings.Join(failures, "\n"))
	}
	if err := zw.Close(); err != nil {
		slog.ErrorContext(ctx, "failed to finish zip", "bucket", bucket, "error", err)
	}
}

// batchDownloadTicket is what a POST /batch-download stores for the
// following GET.
type batchDownloadTicket struct {
	bucket  string
	name    string
	keys    []string
	expires time.Time
}

// batchDownloadTicketStore keeps short-lived, single-use download tickets in
// memory. The browser cannot attach a JSON body to a native download, so the
// key list is POSTed first and the ZIP is then fetched with a plain GET that
// carries only the opaque token. Tickets live in this process only, so with
// several replicas the GET must reach the same one (sticky sessions).
type batchDownloadTicketStore struct {
	mu      sync.Mutex
	tickets map[string]batchDownloadTicket
	ttl     time.Duration
	max     int
	now     func() time.Time
}

func newBatchDownloadTicketStore(ttl time.Duration, max int) *batchDownloadTicketStore {
	return &batchDownloadTicketStore{
		tickets: make(map[string]batchDownloadTicket),
		ttl:     ttl,
		max:     max,
		now:     time.Now,
	}
}

var errTooManyTickets = errors.New("too many pending batch downloads")

// issue stores t and returns its token.
func (s *batchDownloadTicketStore) issue(t batchDownloadTicket) (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw[:])

	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for k, v := range s.tickets {
		if now.After(v.expires) {
			delete(s.tickets, k)
		}
	}
	if len(s.tickets) >= s.max {
		return "", errTooManyTickets
	}
	t.expires = now.Add(s.ttl)
	s.tickets[token] = t
	return token, nil
}

// redeem consumes the token. It fails if the token is unknown, expired or
// was issued for a different bucket.
func (s *batchDownloadTicketStore) redeem(token, bucket string) (batchDownloadTicket, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tickets[token]
	if !ok {
		return batchDownloadTicket{}, false
	}
	delete(s.tickets, token)
	if s.now().After(t.expires) || t.bucket != bucket {
		return batchDownloadTicket{}, false
	}
	return t, true
}

// batchDownloadTickets is the process-wide ticket store (TTL 60s).
var batchDownloadTickets = newBatchDownloadTicketStore(60*time.Second, 256)

// maxKeysBodyBytes bounds JSON bodies that carry key lists.
const maxKeysBodyBytes = 16 << 20

// handleBatchDownloadObjects handles POST /api/objects/{bucket}/batch-download.
// Body: {"keys": [...], "name": "alias"}. It validates the request and
// returns {"token": "...", "expiresIn": 60}; the ZIP is then streamed by
// GET /api/objects/{bucket}/batch-download?token=.
func handleBatchDownloadObjects(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")

		var req batchDownloadRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxKeysBodyBytes)).Decode(&req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body", "")
			return
		}
		if len(req.Keys) == 0 {
			writeJSONError(w, http.StatusBadRequest, "keys array is required and must not be empty", "")
			return
		}
		if len(req.Keys) > maxBatchDownloadKeys {
			writeJSONError(w, http.StatusBadRequest,
				fmt.Sprintf("too many keys: %d (max %d)", len(req.Keys), maxBatchDownloadKeys), "TooManyKeys")
			return
		}

		token, err := batchDownloadTickets.issue(batchDownloadTicket{bucket: bucket, name: req.Name, keys: req.Keys})
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, errTooManyTickets) {
				status = http.StatusTooManyRequests
			}
			writeJSONError(w, status, err.Error(), "")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":     token,
			"expiresIn": int(batchDownloadTickets.ttl / time.Second),
		})
	}
}

// handleBatchDownloadObjectsGet handles GET /api/objects/{bucket}/batch-download?token=.
// It redeems a token issued by the POST endpoint and streams the ZIP, so the
// browser's native download manager handles it (no buffering in JS memory).
func handleBatchDownloadObjectsGet(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")
		token := r.URL.Query().Get("token")
		if token == "" {
			writeJSONError(w, http.StatusBadRequest, "token parameter is required", "")
			return
		}
		ticket, ok := batchDownloadTickets.redeem(token, bucket)
		if !ok {
			writeJSONError(w, http.StatusNotFound, "download token is invalid or expired", "InvalidToken")
			return
		}

		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", attachmentDisposition(zipFilename(bucket, ticket.name)))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")

		streamBatchZip(r.Context(), s3Client, bucket, ticket.keys, w)
	}
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

// handleDeleteObject handles DELETE /api/objects/{bucket}?key=.
// It calls S3 DeleteObject and returns 204 No Content on success.
func handleDeleteObject(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")
		key := r.URL.Query().Get("key")
		if key == "" {
			writeJSONError(w, http.StatusBadRequest, "key parameter is required", "")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), nonStreamingS3Timeout)
		defer cancel()
		_, err := s3Client.client.DeleteObject(ctx, &s3.DeleteObjectInput{
			Bucket: aws.String(bucket),
			Key:    aws.String(key),
		})
		if err != nil {
			slog.ErrorContext(r.Context(), "s3 DeleteObject failed", "bucket", bucket, "key", key, "error", err)
			writeS3Error(w, err, "failed to delete object")
			return
		}
		invalidateListCaches() // object count / usage changed

		w.WriteHeader(http.StatusNoContent)
	}
}

const (
	// deleteObjectsChunk is the S3 DeleteObjects per-request maximum.
	deleteObjectsChunk = 1000
	// maxBatchDeleteKeys caps an explicit key list.
	maxBatchDeleteKeys = 10000
	// maxPrefixDeleteObjects caps one prefix deletion (and the summary
	// count); the response says when more objects remain.
	maxPrefixDeleteObjects = 10000
	// bulkDeleteTimeout bounds a whole batch/prefix deletion.
	bulkDeleteTimeout = 5 * time.Minute
)

// batchDeleteError is one key that S3 refused to delete.
type batchDeleteError struct {
	Key     string `json:"key"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message"`
}

// batchDeleteResponse is returned by the batch and prefix delete endpoints.
type batchDeleteResponse struct {
	Deleted   int                `json:"deleted"`
	Errors    []batchDeleteError `json:"errors"`
	Truncated bool               `json:"truncated"`
}

// deleteKeys removes keys with DeleteObjects in chunks of 1000. Per-key
// failures are collected; a failed request aborts and is returned as err
// together with what was deleted so far, with the chunk's keys listed in
// errs.
func deleteKeys(ctx context.Context, s3Client *S3Client, bucket string, keys []string) (int, []batchDeleteError, error) {
	deleted := 0
	errs := []batchDeleteError{}
	for start := 0; start < len(keys); start += deleteObjectsChunk {
		end := min(start+deleteObjectsChunk, len(keys))
		ids := make([]types.ObjectIdentifier, 0, end-start)
		for _, k := range keys[start:end] {
			ids = append(ids, types.ObjectIdentifier{Key: aws.String(k)})
		}
		out, err := s3Client.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(bucket),
			Delete: &types.Delete{Objects: ids},
		})
		if err != nil {
			_, code := s3ErrorStatus(err)
			for _, k := range keys[start:end] {
				errs = append(errs, batchDeleteError{Key: k, Code: code, Message: err.Error()})
			}
			return deleted, errs, err
		}
		deleted += len(out.Deleted)
		for _, e := range out.Errors {
			errs = append(errs, batchDeleteError{
				Key:     aws.ToString(e.Key),
				Code:    aws.ToString(e.Code),
				Message: aws.ToString(e.Message),
			})
		}
	}
	return deleted, errs, nil
}

// batchDeleteRequest is the JSON body for DELETE /api/objects/{bucket}/batch.
type batchDeleteRequest struct {
	Keys []string `json:"keys"`
}

// handleBatchDeleteObjects handles DELETE /api/objects/{bucket}/batch with
// body {"keys": [...]}. It answers 200 with per-key errors; if nothing could
// be deleted because the S3 request itself failed, the mapped S3 error is
// returned instead.
func handleBatchDeleteObjects(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")
		var req batchDeleteRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxKeysBodyBytes)).Decode(&req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid request body", "")
			return
		}
		seen := make(map[string]struct{}, len(req.Keys))
		keys := make([]string, 0, len(req.Keys))
		for _, k := range req.Keys {
			if k == "" {
				continue
			}
			if _, ok := seen[k]; ok {
				continue
			}
			seen[k] = struct{}{}
			keys = append(keys, k)
		}
		if len(keys) == 0 {
			writeJSONError(w, http.StatusBadRequest, "keys array is required and must not be empty", "")
			return
		}
		if len(keys) > maxBatchDeleteKeys {
			writeJSONError(w, http.StatusBadRequest,
				fmt.Sprintf("too many keys: %d (max %d)", len(keys), maxBatchDeleteKeys), "TooManyKeys")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), bulkDeleteTimeout)
		defer cancel()
		deleted, errs, err := deleteKeys(ctx, s3Client, bucket, keys)
		if err != nil {
			slog.ErrorContext(r.Context(), "s3 DeleteObjects failed", "bucket", bucket, "error", err)
			if deleted == 0 {
				writeS3Error(w, err, "failed to delete objects")
				return
			}
		}
		if deleted > 0 {
			invalidateListCaches() // object count / usage changed
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(batchDeleteResponse{Deleted: deleted, Errors: errs})
	}
}

// prefixSummary is the response of GET /api/objects/{bucket}/prefix-summary.
type prefixSummary struct {
	Count     int   `json:"count"`
	Bytes     int64 `json:"bytes"`
	Truncated bool  `json:"truncated"`
}

// handlePrefixSummary handles GET /api/objects/{bucket}/prefix-summary?prefix=.
// It counts the objects under the prefix (recursively, up to the prefix
// delete cap) so the UI can show the count before a prefix delete.
func handlePrefixSummary(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")
		prefix := r.URL.Query().Get("prefix")

		ctx, cancel := context.WithTimeout(r.Context(), bulkDeleteTimeout)
		defer cancel()
		var sum prefixSummary
		p := s3.NewListObjectsV2Paginator(s3Client.client, &s3.ListObjectsV2Input{
			Bucket: aws.String(bucket),
			Prefix: aws.String(prefix),
		})
		for p.HasMorePages() && !sum.Truncated {
			page, err := p.NextPage(ctx)
			if err != nil {
				slog.ErrorContext(r.Context(), "s3 ListObjectsV2 failed", "bucket", bucket, "error", err)
				writeS3Error(w, err, "failed to list objects")
				return
			}
			for _, obj := range page.Contents {
				if sum.Count >= maxPrefixDeleteObjects {
					sum.Truncated = true
					break
				}
				sum.Count++
				sum.Bytes += aws.ToInt64(obj.Size)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(sum)
	}
}

// handleDeletePrefix handles DELETE /api/objects/{bucket}/prefix?prefix=.
// It deletes every object whose key starts with prefix, at most
// maxPrefixDeleteObjects per call; "truncated": true means more remain and
// the call can be repeated. An empty prefix is rejected so a stray request
// cannot wipe a whole bucket.
func handleDeletePrefix(s3Client *S3Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucket := chi.URLParam(r, "bucket")
		prefix := r.URL.Query().Get("prefix")
		if prefix == "" {
			writeJSONError(w, http.StatusBadRequest, "prefix parameter is required", "")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), bulkDeleteTimeout)
		defer cancel()

		resp := batchDeleteResponse{Errors: []batchDeleteError{}}
		processed := 0
		startAfter := ""
		for {
			input := &s3.ListObjectsV2Input{
				Bucket:  aws.String(bucket),
				Prefix:  aws.String(prefix),
				MaxKeys: aws.Int32(deleteObjectsChunk),
			}
			// Re-list after each deletion instead of following continuation
			// tokens; StartAfter skips keys that failed to delete.
			if startAfter != "" {
				input.StartAfter = aws.String(startAfter)
			}
			page, err := s3Client.client.ListObjectsV2(ctx, input)
			if err != nil {
				slog.ErrorContext(r.Context(), "s3 ListObjectsV2 failed", "bucket", bucket, "prefix", prefix, "error", err)
				if processed == 0 {
					writeS3Error(w, err, "failed to list objects")
					return
				}
				resp.Errors = append(resp.Errors, batchDeleteError{Key: prefix, Message: "listing stopped: " + err.Error()})
				break
			}
			keys := make([]string, 0, len(page.Contents))
			for _, obj := range page.Contents {
				if processed+len(keys) >= maxPrefixDeleteObjects {
					resp.Truncated = true
					break
				}
				keys = append(keys, aws.ToString(obj.Key))
			}
			if len(keys) == 0 {
				break
			}
			deleted, errs, err := deleteKeys(ctx, s3Client, bucket, keys)
			resp.Deleted += deleted
			resp.Errors = append(resp.Errors, errs...)
			processed += len(keys)
			if err != nil {
				slog.ErrorContext(r.Context(), "s3 DeleteObjects failed", "bucket", bucket, "prefix", prefix, "error", err)
				if resp.Deleted == 0 {
					writeS3Error(w, err, "failed to delete objects")
					return
				}
				break
			}
			if resp.Truncated || !aws.ToBool(page.IsTruncated) {
				break
			}
			startAfter = keys[len(keys)-1]
		}

		if resp.Deleted > 0 {
			invalidateListCaches() // object count / usage changed
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}
