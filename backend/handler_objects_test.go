package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	"github.com/go-chi/chi/v5"
)

func TestAttachmentDisposition(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"ascii", "world.tar.zst", `attachment; filename="world.tar.zst"; filename*=UTF-8''world.tar.zst`},
		{"japanese", "ワールド.zip", `attachment; filename="____.zip"; filename*=UTF-8''%E3%83%AF%E3%83%BC%E3%83%AB%E3%83%89.zip`},
		{"quote and backslash", `a"b\c.txt`, `attachment; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`},
		{"control chars dropped", "a\r\nb.txt", `attachment; filename="ab.txt"; filename*=UTF-8''a%0D%0Ab.txt`},
		{"rfc8187 non attr-chars", "backup=2026:10@host.zip", `attachment; filename="backup=2026:10@host.zip"; filename*=UTF-8''backup%3D2026%3A10%40host.zip`},
		{"empty", "", `attachment; filename="download"; filename*=UTF-8''download`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := attachmentDisposition(c.in); got != c.want {
				t.Errorf("attachmentDisposition(%q)\n got: %s\nwant: %s", c.in, got, c.want)
			}
		})
	}
}

func TestZipFilename(t *testing.T) {
	if got := zipFilename("611e4978", ""); got != "611e4978-files.zip" {
		t.Errorf("fallback to bucket id: got %q", got)
	}
	if got := zipFilename("611e4978", "mc-worlds"); got != "mc-worlds-files.zip" {
		t.Errorf("alias preferred: got %q", got)
	}
	if got := zipFilename("611e4978", "../../evil"); got != "....evil-files.zip" {
		t.Errorf("path separators stripped: got %q", got)
	}
	if got := zipFilename("611e4978", "/"); got != "611e4978-files.zip" {
		t.Errorf("empty after sanitizing falls back to bucket: got %q", got)
	}
}

// TestDownloadObjectIntegration runs against a real Garage when
// GARAGE_TEST_S3_ENDPOINT / GARAGE_TEST_S3_ACCESS_KEY / GARAGE_TEST_S3_SECRET_KEY /
// GARAGE_TEST_S3_BUCKET are set. Point it at a throwaway bucket; it writes
// one object and deletes it again afterwards.
func TestDownloadObjectIntegration(t *testing.T) {
	endpoint := os.Getenv("GARAGE_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("GARAGE_TEST_S3_ENDPOINT not set")
	}
	bucket := os.Getenv("GARAGE_TEST_S3_BUCKET")
	client := newS3SDKClient(endpoint, "garage", os.Getenv("GARAGE_TEST_S3_ACCESS_KEY"), os.Getenv("GARAGE_TEST_S3_SECRET_KEY"), 5*time.Second)
	s3c := &S3Client{client: client}

	const key = "dir/ワールド \"quoted\".txt"
	if _, err := client.PutObject(context.Background(), &s3.PutObjectInput{
		Bucket: aws.String(bucket), Key: aws.String(key), Body: strings.NewReader("hello"),
		ContentType: aws.String("text/plain"),
	}); err != nil {
		t.Fatalf("PutObject: %v", err)
	}
	t.Cleanup(func() {
		_, _ = client.DeleteObject(context.Background(), &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	})

	r := chi.NewRouter()
	r.Get("/api/objects/{bucket}/download", handleDownloadObject(s3c))
	req := httptest.NewRequest(http.MethodGet, "/api/objects/"+bucket+"/download?key="+url.QueryEscape(key), nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "hello" {
		t.Fatalf("body = %q", got)
	}
	want := `attachment; filename="____ _quoted_.txt"; filename*=UTF-8''%E3%83%AF%E3%83%BC%E3%83%AB%E3%83%89%20%22quoted%22.txt`
	if got := rec.Header().Get("Content-Disposition"); got != want {
		t.Errorf("Content-Disposition = %s\nwant %s", got, want)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/plain" {
		t.Errorf("Content-Type = %q", got)
	}
}

func TestSanitizeZipEntryName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"world/region/r.0.0.mca", "world/region/r.0.0.mca"},
		{"/etc/passwd", "etc/passwd"},
		{"../../evil.sh", "evil.sh"},
		{"a/../../b/./c.txt", "a/b/c.txt"},
		{`..\..\windows\evil.dll`, "windows/evil.dll"},
		{"C:/Windows/evil.dll", "C_/Windows/evil.dll"},
		{"dir//double///slash.txt", "dir/double/slash.txt"},
		{"ctrl\x00\x1fname.txt", "ctrlname.txt"},
		{"folder/", "folder/"},
		{"../", ""},
		{"..", ""},
		{"/", ""},
		{"ワールド/バックアップ.zip", "ワールド/バックアップ.zip"},
	}
	for _, c := range cases {
		if got := sanitizeZipEntryName(c.in); got != c.want {
			t.Errorf("sanitizeZipEntryName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestZipNamerUnique(t *testing.T) {
	n := newZipNamer()
	got := []string{
		n.unique("a/b.txt"),
		n.unique("a/b.txt"),
		n.unique("a/b.txt"),
		n.unique(".env"),
		n.unique(".env"),
		n.unique("noext"),
		n.unique("noext"),
	}
	want := []string{"a/b.txt", "a/b (1).txt", "a/b (2).txt", ".env", ".env (1)", "noext", "noext (1)"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("unique #%d = %q, want %q", i, got[i], want[i])
		}
	}
	if !n.claimDir("d/") || n.claimDir("d/") {
		t.Error("claimDir should accept a directory once")
	}
}

func TestZipMethodFor(t *testing.T) {
	if zipMethodFor("world.TAR.GZ") != zip.Store || zipMethodFor("r.0.0.mca") != zip.Store {
		t.Error("compressed extensions should be stored")
	}
	if zipMethodFor("level.dat_old") != zip.Deflate || zipMethodFor("log.txt") != zip.Deflate {
		t.Error("other files should be deflated")
	}
}

func TestS3ErrorStatus(t *testing.T) {
	cases := []struct {
		err        error
		wantStatus int
		wantCode   string
	}{
		{fmt.Errorf("op: %w", &smithy.GenericAPIError{Code: "NoSuchKey", Message: "nope"}), 404, "NoSuchKey"},
		{&smithy.GenericAPIError{Code: "NoSuchBucket"}, 404, "NoSuchBucket"},
		{&smithy.GenericAPIError{Code: "NotFound"}, 404, "NotFound"},
		{&smithy.GenericAPIError{Code: "AccessDenied"}, 403, "AccessDenied"},
		{&smithy.GenericAPIError{Code: "InternalError"}, 502, "InternalError"},
		{errors.New("dial tcp: connection refused"), 502, ""},
	}
	for _, c := range cases {
		status, code := s3ErrorStatus(c.err)
		if status != c.wantStatus || code != c.wantCode {
			t.Errorf("s3ErrorStatus(%v) = %d %q, want %d %q", c.err, status, code, c.wantStatus, c.wantCode)
		}
	}
}

func TestWriteJSONErrorEscapes(t *testing.T) {
	rec := httptest.NewRecorder()
	writeObjectError(rec, http.StatusBadGateway, "boom \"quoted\"\nline", "X")
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON %q: %v", rec.Body.String(), err)
	}
	if body["error"] != "boom \"quoted\"\nline" || body["code"] != "X" {
		t.Errorf("body = %v", body)
	}
	if rec.Code != http.StatusBadGateway || rec.Header().Get("Content-Type") != "application/json" {
		t.Errorf("status %d content-type %q", rec.Code, rec.Header().Get("Content-Type"))
	}
}

func TestBatchDownloadTicketStore(t *testing.T) {
	s := newBatchDownloadTicketStore(time.Minute, 2)
	now := time.Unix(1000, 0)
	s.now = func() time.Time { return now }

	tok, err := s.issue(batchDownloadTicket{bucket: "b", keys: []string{"k"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.redeem(tok, "other"); ok {
		t.Error("token must be bound to its bucket")
	}
	if _, ok := s.redeem(tok, "b"); ok {
		t.Error("a failed redeem still consumes the token")
	}

	tok, _ = s.issue(batchDownloadTicket{bucket: "b", keys: []string{"k"}})
	got, ok := s.redeem(tok, "b")
	if !ok || len(got.keys) != 1 {
		t.Fatalf("redeem = %v %v", got, ok)
	}
	if _, ok := s.redeem(tok, "b"); ok {
		t.Error("token must be single-use")
	}

	tok, _ = s.issue(batchDownloadTicket{bucket: "b"})
	now = now.Add(61 * time.Second)
	if _, ok := s.redeem(tok, "b"); ok {
		t.Error("expired token must be rejected")
	}

	s.issue(batchDownloadTicket{bucket: "b"})
	s.issue(batchDownloadTicket{bucket: "b"})
	if _, err := s.issue(batchDownloadTicket{bucket: "b"}); !errors.Is(err, errTooManyTickets) {
		t.Errorf("expected errTooManyTickets, got %v", err)
	}
	// Expired tickets are pruned and free their slot.
	now = now.Add(2 * time.Minute)
	if _, err := s.issue(batchDownloadTicket{bucket: "b"}); err != nil {
		t.Errorf("issue after expiry: %v", err)
	}
}

func TestBatchDownloadPostValidation(t *testing.T) {
	r := chi.NewRouter()
	r.Post("/api/objects/{bucket}/batch-download", handleBatchDownloadObjects(&S3Client{}))

	tooMany := make([]string, maxBatchDownloadKeys+1)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("k%d", i)
	}
	for name, body := range map[string]any{
		"empty":    map[string]any{"keys": []string{}},
		"too many": map[string]any{"keys": tooMany},
	} {
		b, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/objects/b/batch-download", bytes.NewReader(b)))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d body = %s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestBatchDownloadGetRejectsUnknownToken(t *testing.T) {
	r := chi.NewRouter()
	r.Get("/api/objects/{bucket}/batch-download", handleBatchDownloadObjectsGet(&S3Client{}))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/objects/b/batch-download?token=deadbeef", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/objects/b/batch-download?key=a&key=b", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("legacy key= variant: status = %d", rec.Code)
	}
}

func TestDeletePrefixRequiresPrefix(t *testing.T) {
	r := chi.NewRouter()
	r.Delete("/api/objects/{bucket}/prefix", handleDeletePrefix(&S3Client{}))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/objects/b/prefix", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d", rec.Code)
	}
}

// fakeS3 serves GetObject for a fixed set of objects and NoSuchKey/NoSuchBucket
// errors otherwise, which is enough for the ZIP streaming and error mapping
// paths without a real Garage.
func fakeS3(t *testing.T, objects map[string]string) *S3Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/b/") {
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, `<?xml version="1.0"?><Error><Code>NoSuchBucket</Code><Message>bucket "x" not found</Message></Error>`)
			return
		}
		key := strings.TrimPrefix(r.URL.Path, "/b/")
		body, ok := objects[key]
		if ok && r.Method == http.MethodHead {
			w.Header().Set("Content-Length", fmt.Sprint(len(body)))
			return
		}
		if !ok || r.Method != http.MethodGet {
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, `<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>key not found</Message></Error>`)
			return
		}
		w.Header().Set("Last-Modified", "Mon, 02 Jan 2006 15:04:05 GMT")
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return &S3Client{client: newS3SDKClient(srv.URL, "garage", "ak", "sk", 5*time.Second)}
}

func TestStreamBatchZipSanitizesAndReportsErrors(t *testing.T) {
	s3c := fakeS3(t, map[string]string{
		"dir/a.txt":    "A",
		"dir/b.tar.gz": "B",
		"_errors.txt":  "real object",
	})
	var buf bytes.Buffer
	keys := []string{"dir/a.txt", "/dir/a.txt", "dir/b.tar.gz", "missing.txt", "_errors.txt"}
	streamBatchZip(context.Background(), s3c, "b", keys, &buf)

	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("invalid zip: %v", err)
	}
	entries := map[string]*zip.File{}
	var names []string
	for _, f := range zr.File {
		entries[f.Name] = f
		names = append(names, f.Name)
	}
	// No key may produce an absolute or traversing entry name.
	for _, n := range names {
		if strings.HasPrefix(n, "/") || strings.Contains(n, "..") {
			t.Errorf("unsafe entry name %q", n)
		}
	}
	if _, ok := entries["dir/a.txt"]; !ok {
		t.Errorf("missing dir/a.txt in %v", names)
	}
	gz := entries["dir/b.tar.gz"]
	if gz == nil || gz.Method != zip.Store {
		t.Errorf("tar.gz should be stored: %+v", gz)
	}
	if f := entries["dir/a.txt"]; f != nil && f.Modified.UTC().Year() != 2006 {
		t.Errorf("Modified = %v, want LastModified from S3", f.Modified)
	}
	if _, ok := entries["_errors.txt"]; !ok {
		t.Errorf("the real _errors.txt object should keep its name: %v", names)
	}
	errEntry := entries["_errors (1).txt"]
	if errEntry == nil {
		t.Fatalf("missing error report entry in %v", names)
	}
	rc, _ := errEntry.Open()
	report, _ := io.ReadAll(rc)
	rc.Close()
	if !strings.Contains(string(report), "missing.txt") {
		t.Errorf("error report = %q", report)
	}
}

func TestStreamBatchZipFolderMarkers(t *testing.T) {
	s3c := fakeS3(t, map[string]string{
		"empty-dir/": "",
		"not-a-dir/": "payload",
	})
	var buf bytes.Buffer
	streamBatchZip(context.Background(), s3c, "b", []string{"empty-dir/", "not-a-dir/"}, &buf)
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("invalid zip: %v", err)
	}
	got := map[string]bool{}
	for _, f := range zr.File {
		got[f.Name] = true
	}
	if !got["empty-dir/"] || !got["not-a-dir"] || len(got) != 2 {
		t.Errorf("entries = %v, want empty-dir/ as a directory and not-a-dir as a file", got)
	}
}

func TestUploadPartSize(t *testing.T) {
	if got := uploadPartSize(10 << 30); got != manager.MinUploadPartSize {
		t.Errorf("10 GiB cap: part size %d, want the 5 MiB minimum", got)
	}
	if got := uploadPartSize(100 << 30); got <= manager.MinUploadPartSize || got > maxUploadPartSize {
		t.Errorf("100 GiB cap: part size %d out of range", got)
	}
	if got := uploadPartSize(10 << 40); got != maxUploadPartSize {
		t.Errorf("10 TiB cap: part size %d, want the 64 MiB cap", got)
	}
}

// countingReader records how much of a request body the server consumed.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// TestUploadConflictDrainsBody checks that an early 409 is sent only after
// the body has been read, so the connection is not reset under a browser
// that is still uploading.
func TestUploadConflictDrainsBody(t *testing.T) {
	s3c := fakeS3(t, map[string]string{"exists.bin": "x"})
	r := chi.NewRouter()
	r.Post("/api/objects/{bucket}/upload", handleUploadObject(s3c))
	srv := httptest.NewServer(r)
	defer srv.Close()

	body, ct := multipartBody(t, "", "exists.bin", bytes.Repeat([]byte("y"), 8<<20))
	total := int64(body.Len())
	cr := &countingReader{r: body}
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/objects/b/upload?overwrite=false&key=exists.bin", cr)
	req.Header.Set("Content-Type", ct)
	req.ContentLength = total
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed (connection reset?): %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if cr.n != total {
		t.Errorf("server read %d of %d body bytes before answering", cr.n, total)
	}
}

func TestObjectHandlersMapS3Errors(t *testing.T) {
	s3c := fakeS3(t, nil)
	r := chi.NewRouter()
	r.Get("/api/objects/{bucket}/list", handleListObjects(s3c))
	r.Get("/api/objects/{bucket}/download", handleDownloadObject(s3c))

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/objects/nosuch/list", nil))
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON %q", rec.Body.String())
	}
	if rec.Code != http.StatusNotFound || body["code"] != "NoSuchBucket" {
		t.Errorf("list: status %d body %v", rec.Code, body)
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/objects/b/download?key=nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("download: status %d body %s", rec.Code, rec.Body.String())
	}
}

// multipartBody builds an upload body with an optional key field before the
// file part.
func multipartBody(t *testing.T, key, filename string, content []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if key != "" {
		mw.WriteField("key", key)
	}
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	fw.Write(content)
	mw.Close()
	return &buf, mw.FormDataContentType()
}

func TestUploadRejectsOversizedBody(t *testing.T) {
	// The S3 endpoint is never reached: the size cap trips first.
	s3c := &S3Client{
		client:         newS3SDKClient("http://127.0.0.1:1", "garage", "ak", "sk", time.Second),
		maxUploadBytes: 512,
	}
	r := chi.NewRouter()
	r.Post("/api/objects/{bucket}/upload", handleUploadObject(s3c))

	for _, chunked := range []bool{false, true} {
		body, ct := multipartBody(t, "big.bin", "big.bin", bytes.Repeat([]byte("x"), 4096))
		req := httptest.NewRequest(http.MethodPost, "/api/objects/b/upload", body)
		req.Header.Set("Content-Type", ct)
		if chunked {
			req.ContentLength = -1
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("chunked=%v: status %d body %s", chunked, rec.Code, rec.Body.String())
		}
	}
}

func TestParseMaxUploadBytes(t *testing.T) {
	if parseMaxUploadBytes("") != defaultMaxUploadBytes || parseMaxUploadBytes("abc") != defaultMaxUploadBytes ||
		parseMaxUploadBytes("-1") != defaultMaxUploadBytes {
		t.Error("invalid values should fall back to the default")
	}
	if parseMaxUploadBytes("1048576") != 1048576 {
		t.Error("explicit value should be used")
	}
}

// --- Integration tests against a real Garage --------------------------------

// i381TestBuckets returns the S3 client plus the bucket as both its alias
// (GARAGE_TEST_S3_BUCKET) and, when the admin API env is set, its 64-hex ID,
// which is what the UI puts in the URL.
func i381TestBuckets(t *testing.T) (*S3Client, map[string]string) {
	t.Helper()
	endpoint := os.Getenv("GARAGE_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("GARAGE_TEST_S3_ENDPOINT not set")
	}
	alias := os.Getenv("GARAGE_TEST_S3_BUCKET")
	s3c := &S3Client{client: newS3SDKClient(endpoint, "garage",
		os.Getenv("GARAGE_TEST_S3_ACCESS_KEY"), os.Getenv("GARAGE_TEST_S3_SECRET_KEY"), 10*time.Second)}
	buckets := map[string]string{"alias": alias}

	if adminEndpoint := os.Getenv("GARAGE_TEST_ADMIN_ENDPOINT"); adminEndpoint != "" {
		req, _ := http.NewRequest(http.MethodGet, adminEndpoint+"/v2/GetBucketInfo?globalAlias="+url.QueryEscape(alias), nil)
		req.Header.Set("Authorization", "Bearer "+os.Getenv("GARAGE_TEST_ADMIN_TOKEN"))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GetBucketInfo: %v", err)
		}
		defer resp.Body.Close()
		var info struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&info); err != nil || len(info.ID) != 64 {
			t.Fatalf("GetBucketInfo: id %q err %v", info.ID, err)
		}
		buckets["id"] = info.ID
	}

	t.Cleanup(func() { i381Cleanup(t, s3c, alias) })
	return s3c, buckets
}

// i381Cleanup removes every i381- object left behind by these tests.
func i381Cleanup(t *testing.T, s3c *S3Client, bucket string) {
	ctx := context.Background()
	p := s3.NewListObjectsV2Paginator(s3c.client, &s3.ListObjectsV2Input{Bucket: aws.String(bucket), Prefix: aws.String("i381-")})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			t.Logf("cleanup list: %v", err)
			return
		}
		for _, obj := range page.Contents {
			s3c.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: obj.Key})
		}
	}
}

func i381Router(s3c *S3Client) http.Handler {
	r := chi.NewRouter()
	r.Get("/api/objects/{bucket}/list", handleListObjects(s3c))
	r.Get("/api/objects/{bucket}/download", handleDownloadObject(s3c))
	r.Post("/api/objects/{bucket}/batch-download", handleBatchDownloadObjects(s3c))
	r.Get("/api/objects/{bucket}/batch-download", handleBatchDownloadObjectsGet(s3c))
	r.Post("/api/objects/{bucket}/upload", handleUploadObject(s3c))
	r.Delete("/api/objects/{bucket}", handleDeleteObject(s3c))
	r.Delete("/api/objects/{bucket}/batch", handleBatchDeleteObjects(s3c))
	r.Get("/api/objects/{bucket}/prefix-summary", handlePrefixSummary(s3c))
	r.Delete("/api/objects/{bucket}/prefix", handleDeletePrefix(s3c))
	return r
}

func doJSON(t *testing.T, h http.Handler, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, target, rd)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestObjectBrowserIntegration(t *testing.T) {
	s3c, buckets := i381TestBuckets(t)
	h := i381Router(s3c)

	for label, bucket := range buckets {
		t.Run(label, func(t *testing.T) {
			prefix := fmt.Sprintf("i381-%s-%d/", label, time.Now().UnixNano())
			base := "/api/objects/" + bucket

			upload := func(key string, content []byte, query string) *httptest.ResponseRecorder {
				body, ct := multipartBody(t, key, path.Base(key), content)
				req := httptest.NewRequest(http.MethodPost, base+"/upload"+query, body)
				req.Header.Set("Content-Type", ct)
				req.ContentLength = -1 // exercise the streaming path, like a browser upload of unknown size
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, req)
				return rec
			}

			// Upload: small file, then a multi-part one (> 5 MiB part size).
			if rec := upload(prefix+"a.txt", []byte("hello"), "?overwrite=false"); rec.Code != http.StatusCreated {
				t.Fatalf("upload a.txt: %d %s", rec.Code, rec.Body.String())
			}
			big := bytes.Repeat([]byte("0123456789abcdef"), (6<<20)/16+3)
			if rec := upload(prefix+"sub/big.bin", big, ""); rec.Code != http.StatusCreated {
				t.Fatalf("upload big.bin: %d %s", rec.Code, rec.Body.String())
			}
			// overwrite=false: 409 both via form-field key and via query key.
			if rec := upload(prefix+"a.txt", []byte("again"), "?overwrite=false"); rec.Code != http.StatusConflict {
				t.Fatalf("expected 409, got %d %s", rec.Code, rec.Body.String())
			}
			if rec := upload("", []byte("again"), "?overwrite=false&key="+url.QueryEscape(prefix+"a.txt")); rec.Code != http.StatusConflict {
				t.Fatalf("expected 409 for query key, got %d %s", rec.Code, rec.Body.String())
			}
			if rec := upload(prefix+"a.txt", []byte("world"), "?overwrite=true"); rec.Code != http.StatusCreated {
				t.Fatalf("overwrite: %d %s", rec.Code, rec.Body.String())
			}

			// Download returns the overwritten content; big object round-trips.
			rec := doJSON(t, h, http.MethodGet, base+"/download?key="+url.QueryEscape(prefix+"a.txt"), nil)
			if rec.Code != http.StatusOK || rec.Body.String() != "world" {
				t.Fatalf("download: %d %q", rec.Code, rec.Body.String())
			}
			rec = doJSON(t, h, http.MethodGet, base+"/download?key="+url.QueryEscape(prefix+"sub/big.bin"), nil)
			if !bytes.Equal(rec.Body.Bytes(), big) {
				t.Fatalf("big.bin round-trip mismatch: got %d bytes", rec.Body.Len())
			}
			rec = doJSON(t, h, http.MethodGet, base+"/download?key="+url.QueryEscape(prefix+"missing"), nil)
			if rec.Code != http.StatusNotFound {
				t.Errorf("missing object: %d %s", rec.Code, rec.Body.String())
			}

			// A key with traversal segments, put directly. ".." segments are
			// dropped, so it lands as prefix+"evil.txt" inside the archive.
			evilKey := prefix + "../../evil.txt"
			if _, err := s3c.client.PutObject(context.Background(), &s3.PutObjectInput{
				Bucket: aws.String(bucket), Key: aws.String(evilKey), Body: strings.NewReader("evil"),
			}); err != nil {
				t.Fatalf("PutObject evil: %v", err)
			}

			// List.
			rec = doJSON(t, h, http.MethodGet, base+"/list?prefix="+url.QueryEscape(prefix), nil)
			var list objectListResponse
			json.Unmarshal(rec.Body.Bytes(), &list)
			if rec.Code != http.StatusOK || len(list.Objects) != 1 || list.Objects[0].Key != prefix+"a.txt" ||
				list.Objects[0].LastModified.IsZero() {
				t.Fatalf("list: %d %+v", rec.Code, list)
			}

			// ZIP via token.
			rec = doJSON(t, h, http.MethodPost, base+"/batch-download", map[string]any{
				"keys": []string{prefix + "a.txt", prefix + "sub/big.bin", evilKey, prefix + "missing.txt"},
				"name": "i381",
			})
			var tok struct {
				Token string `json:"token"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &tok); err != nil || tok.Token == "" {
				t.Fatalf("token: %d %s", rec.Code, rec.Body.String())
			}
			rec = doJSON(t, h, http.MethodGet, base+"/batch-download?token="+tok.Token, nil)
			if rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Content-Disposition"), "i381-files.zip") {
				t.Fatalf("zip: %d %v", rec.Code, rec.Header())
			}
			zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
			if err != nil {
				t.Fatalf("zip reader: %v", err)
			}
			got := map[string]bool{}
			for _, f := range zr.File {
				got[f.Name] = true
				if strings.Contains(f.Name, "..") || strings.HasPrefix(f.Name, "/") {
					t.Errorf("unsafe zip entry %q", f.Name)
				}
			}
			for _, want := range []string{prefix + "a.txt", prefix + "sub/big.bin", prefix + "evil.txt", "_errors.txt"} {
				if !got[want] {
					t.Errorf("zip lacks %q: %v", want, got)
				}
			}
			if rec := doJSON(t, h, http.MethodGet, base+"/batch-download?token="+tok.Token, nil); rec.Code != http.StatusNotFound {
				t.Errorf("token reuse: %d", rec.Code)
			}

			// Summary and deletes.
			rec = doJSON(t, h, http.MethodGet, base+"/prefix-summary?prefix="+url.QueryEscape(prefix), nil)
			var sum prefixSummary
			json.Unmarshal(rec.Body.Bytes(), &sum)
			if sum.Count != 3 || sum.Bytes != int64(5+4+len(big)) {
				t.Errorf("summary: %+v", sum)
			}
			rec = doJSON(t, h, http.MethodDelete, base+"/batch", map[string]any{"keys": []string{prefix + "a.txt", evilKey}})
			var del batchDeleteResponse
			json.Unmarshal(rec.Body.Bytes(), &del)
			if rec.Code != http.StatusOK || del.Deleted != 2 || len(del.Errors) != 0 {
				t.Fatalf("batch delete: %d %s", rec.Code, rec.Body.String())
			}
			rec = doJSON(t, h, http.MethodDelete, base+"/prefix?prefix="+url.QueryEscape(prefix), nil)
			del = batchDeleteResponse{}
			json.Unmarshal(rec.Body.Bytes(), &del)
			if rec.Code != http.StatusOK || del.Deleted != 1 || del.Truncated {
				t.Fatalf("prefix delete: %d %s", rec.Code, rec.Body.String())
			}
			rec = doJSON(t, h, http.MethodGet, base+"/prefix-summary?prefix="+url.QueryEscape(prefix), nil)
			sum = prefixSummary{}
			json.Unmarshal(rec.Body.Bytes(), &sum)
			if sum.Count != 0 {
				t.Errorf("objects left after prefix delete: %+v", sum)
			}
		})
	}

	// Over a real connection, overwrite=false with the key in the query is
	// answered with 409 (after the body is drained, without a reset) and
	// nothing is written to S3.
	t.Run("early conflict over http", func(t *testing.T) {
		bucket := buckets["alias"]
		key := fmt.Sprintf("i381-conflict-%d.bin", time.Now().UnixNano())
		if _, err := s3c.client.PutObject(context.Background(), &s3.PutObjectInput{
			Bucket: aws.String(bucket), Key: aws.String(key), Body: strings.NewReader("x"),
		}); err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewServer(h)
		defer srv.Close()
		body, ct := multipartBody(t, "", "c.bin", bytes.Repeat([]byte("y"), 20<<20))
		start := time.Now()
		resp, err := http.Post(srv.URL+"/api/objects/"+bucket+"/upload?overwrite=false&key="+url.QueryEscape(key), ct, body)
		if err != nil {
			t.Fatalf("POST: %v", err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusConflict {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		t.Logf("409 after %v", time.Since(start))
	})

	// Unknown bucket maps to 404.
	rec := doJSON(t, h, http.MethodGet, "/api/objects/i381-no-such-bucket/list", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown bucket: %d %s", rec.Code, rec.Body.String())
	}
}
