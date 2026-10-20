package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
)

// Audit logging.
//
// Every mutating request (POST / PUT / PATCH / DELETE, except the
// /api/auth/* login/logout flow) emits an extra INFO line with msg "audit"
// carrying who did what to which resource:
//
//	user, method, path, route, status, duration_ms, params, query, detail,
//	garageErrors
//
// (trace_id / span_id are added by traceHandler when a span is active.)
// Login and logout are audited by their handlers instead, as msg "audit"
// with event "login" / "logout" (see auditAuthEvent).
//
// The request body is never logged, because it can carry secrets (key
// secrets, admin tokens, ...). The only exceptions are a few allowlisted,
// non-secret fields read from the first maxAuditBodyBytes of the body of
// specific endpoints, see auditExtractors. Headers (Authorization, Cookie)
// are never logged either.

// maxAuditBodyBytes bounds how much of a request body (and of a response
// body) the audit middleware reads. Request bodies are always restored in
// full for the downstream handler.
const maxAuditBodyBytes = 4 << 10

// auditPreviewItems is how many object keys / block hashes a detail lists.
const auditPreviewItems = 5

// auditMaxValueBytes caps every string value written to the audit line
// (query values, object keys, ...). Truncation keeps valid UTF-8.
const auditMaxValueBytes = 256

// auditQueryAllowlist lists the query parameters that may appear in the audit
// line: the ones the handlers actually read and that never carry
// credentials. Everything else (OAuth code/state, the batch-download ticket
// "token", S3 "continuation-token", unknown parameters) is dropped.
var auditQueryAllowlist = map[string]bool{
	"prefix":        true,
	"delimiter":     true,
	"key":           true,
	"accessKeyId":   true,
	"overwrite":     true,
	"showSecretKey": true,
}

// auditSafeToken matches enum-like strings (repair types, variable names)
// that are safe to log verbatim.
var auditSafeToken = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)

// auditExtractor pulls the detail fields out of a (possibly truncated)
// request body. complete is false when the body exceeded maxAuditBodyBytes
// and buf is only its prefix.
type auditExtractor func(buf []byte, complete bool) map[string]any

// auditExtractors maps "METHOD path-regexp" to the extractor of that route.
// Paths are matched before routing (the middleware runs outside chi's
// subrouters), so they are spelled out as regular expressions.
var auditExtractors = []struct {
	method  string
	path    *regexp.Regexp
	extract auditExtractor
}{
	{http.MethodPost, regexp.MustCompile(`^/api/repair$`), extractRepairType},
	{http.MethodPost, regexp.MustCompile(`^/api/nodes/[^/]+/repair$`), extractRepairType},
	{http.MethodPost, regexp.MustCompile(`^/api/nodes/[^/]+/worker-variables$`), extractWorkerVariable},
	{http.MethodPost, regexp.MustCompile(`^/api/nodes/[^/]+/snapshot$`), extractAllNodes},
	{http.MethodDelete, regexp.MustCompile(`^/api/objects/[^/]+/batch$`), extractObjectKeys},
	{http.MethodPost, regexp.MustCompile(`^/api/blocks/purge$`), extractBlockHashes},
	{http.MethodPost, regexp.MustCompile(`^/api/cluster/layout/(apply|revert)$`), extractLayoutVersion},
	{http.MethodPost, regexp.MustCompile(`^/api/cluster/layout/skip-dead-nodes$`), extractLayoutVersion},
	{http.MethodPost, regexp.MustCompile(`^/api/buckets/[^/]+/cleanup-uploads$`), extractOlderThanSecs},
	{http.MethodPut, regexp.MustCompile(`^/api/buckets/[^/]+/keys/[^/]+$`), extractPermissions},
}

// auditResponseDetail lists routes whose detail comes from the response
// instead of the request: console-access has an empty body, the resulting
// permissions are decided by the server.
var auditResponseDetail = regexp.MustCompile(`^/api/buckets/[^/]+/console-access$`)

// sessionUser returns the GitHub login stored in the session cookie, or "" if
// the request is unauthenticated (or auth is not initialised). It goes
// through sessionStore.Get so the decoded session is cached in the request's
// session registry and reused by authMiddleware and the handlers.
func sessionUser(r *http.Request) string {
	if sessionStore == nil {
		return ""
	}
	sess, err := sessionStore.Get(r, sessionName)
	if err != nil || sess == nil {
		return ""
	}
	user, _ := sess.Values[sessionKeyUser].(string)
	return user
}

// isAuditedRequest reports whether r is a mutation the middleware audits.
func isAuditedRequest(r *http.Request) bool {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return false
	}
	return !strings.HasPrefix(r.URL.Path, "/api/auth/")
}

// auditDetail extracts the allowlisted, non-secret fields from the body of
// the routes in auditExtractors and restores r.Body so the downstream handler
// still sees the full body. It reads at most maxAuditBodyBytes+1 bytes.
func auditDetail(r *http.Request) map[string]any {
	if r.Body == nil || r.Body == http.NoBody {
		return nil
	}
	var extract auditExtractor
	for _, e := range auditExtractors {
		if e.method == r.Method && e.path.MatchString(r.URL.Path) {
			extract = e.extract
			break
		}
	}
	if extract == nil {
		return nil
	}

	orig := r.Body
	buf, err := io.ReadAll(io.LimitReader(orig, maxAuditBodyBytes+1))
	// Hand the already-read prefix plus the unread remainder back to the
	// handler, keeping the original Close.
	r.Body = struct {
		io.Reader
		io.Closer
	}{io.MultiReader(bytes.NewReader(buf), orig), orig}
	if err != nil {
		return nil
	}
	complete := len(buf) <= maxAuditBodyBytes
	if !complete {
		buf = buf[:maxAuditBodyBytes]
	}
	d := extract(buf, complete)
	if len(d) == 0 {
		return nil
	}
	return d
}

// extractRepairType returns {"repairType": ...} for a LaunchRepairOperation
// body. Garage's RepairType is either a plain string ("blockRc") or a
// one-key object ({"scrub": "start"}), recorded as "scrub:start".
func extractRepairType(body []byte, complete bool) map[string]any {
	if !complete {
		return nil
	}
	var req struct {
		RepairType json.RawMessage `json:"repairType"`
	}
	if json.Unmarshal(body, &req) != nil || len(req.RepairType) == 0 {
		return nil
	}
	var s string
	if json.Unmarshal(req.RepairType, &s) == nil {
		if auditSafeToken.MatchString(s) {
			return map[string]any{"repairType": s}
		}
		return nil
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(req.RepairType, &obj) != nil || len(obj) != 1 {
		return nil
	}
	for k, v := range obj {
		var sub string
		if !auditSafeToken.MatchString(k) || json.Unmarshal(v, &sub) != nil || !auditSafeToken.MatchString(sub) {
			return nil
		}
		return map[string]any{"repairType": k + ":" + sub}
	}
	return nil
}

// extractWorkerVariable returns {"variable": name, "allNodes": bool} for a
// SetWorkerVariable body (setWorkerVariableRequest). The value is
// intentionally not recorded.
func extractWorkerVariable(body []byte, complete bool) map[string]any {
	if !complete {
		return nil
	}
	var req struct {
		Variable string `json:"variable"`
		AllNodes bool   `json:"allNodes"`
	}
	if json.Unmarshal(body, &req) != nil {
		return nil
	}
	v := strings.TrimSpace(req.Variable)
	if !auditSafeToken.MatchString(v) {
		return nil
	}
	return map[string]any{"variable": v, "allNodes": req.AllNodes}
}

// extractAllNodes returns {"allNodes": bool} for the snapshot body.
func extractAllNodes(body []byte, complete bool) map[string]any {
	if !complete {
		return nil
	}
	var req struct {
		AllNodes bool `json:"allNodes"`
	}
	if json.Unmarshal(body, &req) != nil {
		return nil
	}
	return map[string]any{"allNodes": req.AllNodes}
}

// extractObjectKeys summarises a batch delete body ({"keys": [...]},
// batchDeleteRequest) as keyCount + the first auditPreviewItems keys. When
// the body is larger than the read limit, keyCount is omitted and
// keyCountAtLeast / truncated say how far the prefix got.
func extractObjectKeys(body []byte, complete bool) map[string]any {
	dec := json.NewDecoder(bytes.NewReader(body))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil
	}
	for {
		t, err := dec.Token()
		if err != nil {
			return nil
		}
		name, ok := t.(string)
		if !ok {
			return nil
		}
		if name == "keys" {
			return stringArraySummary(dec, "keys", "keyCount", complete)
		}
		// Skip the value of any other field.
		var skip json.RawMessage
		if dec.Decode(&skip) != nil {
			return nil
		}
	}
}

// extractBlockHashes summarises a PurgeBlocks body (a JSON array of block
// hashes, LocalPurgeBlocksRequest) as hashCount + the first hashes.
func extractBlockHashes(body []byte, complete bool) map[string]any {
	return stringArraySummary(json.NewDecoder(bytes.NewReader(body)), "hashes", "hashCount", complete)
}

// stringArraySummary reads a JSON array of strings from dec and returns
// {countField: n, itemsField: first items}. A body cut at the read limit
// yields {countField+"AtLeast": n, "truncated": true, itemsField: ...}.
func stringArraySummary(dec *json.Decoder, itemsField, countField string, complete bool) map[string]any {
	if t, err := dec.Token(); err != nil || t != json.Delim('[') {
		return nil
	}
	items := []string{}
	n := 0
	for {
		t, err := dec.Token()
		if err != nil {
			if complete || n == 0 {
				return nil
			}
			return map[string]any{countField + "AtLeast": n, "truncated": true, itemsField: items}
		}
		if t == json.Delim(']') {
			return map[string]any{countField: n, itemsField: items}
		}
		s, ok := t.(string)
		if !ok {
			return nil
		}
		// A string token cut at the read limit fails to decode, so every
		// counted item is complete.
		n++
		if len(items) < auditPreviewItems {
			items = append(items, truncateUTF8(s, auditMaxValueBytes))
		}
	}
}

// extractLayoutVersion returns {"version": n} (plus allowMissingData for
// skip-dead-nodes) for the layout apply / revert / skip-dead-nodes bodies.
func extractLayoutVersion(body []byte, complete bool) map[string]any {
	if !complete {
		return nil
	}
	var req struct {
		Version          *int64 `json:"version"`
		AllowMissingData *bool  `json:"allowMissingData"`
	}
	if json.Unmarshal(body, &req) != nil {
		return nil
	}
	d := map[string]any{}
	if req.Version != nil {
		d["version"] = *req.Version
	}
	if req.AllowMissingData != nil {
		d["allowMissingData"] = *req.AllowMissingData
	}
	return d
}

// extractOlderThanSecs returns {"olderThanSecs": n} for the cleanup-uploads body.
func extractOlderThanSecs(body []byte, complete bool) map[string]any {
	if !complete {
		return nil
	}
	var req struct {
		OlderThanSecs *int64 `json:"olderThanSecs"`
	}
	if json.Unmarshal(body, &req) != nil || req.OlderThanSecs == nil {
		return nil
	}
	return map[string]any{"olderThanSecs": *req.OlderThanSecs}
}

// extractPermissions returns {"read","write","owner"} for the PUT
// /api/buckets/{id}/keys/{kid} body (bucketKeyPerm).
func extractPermissions(body []byte, complete bool) map[string]any {
	if !complete {
		return nil
	}
	var p bucketKeyPerm
	if json.Unmarshal(body, &p) != nil {
		return nil
	}
	return map[string]any{"read": p.Read, "write": p.Write, "owner": p.Owner}
}

// cappedBuffer keeps the first max bytes written to it and remembers whether
// more were written. Write never fails, so it is safe as a response tee.
type cappedBuffer struct {
	buf      bytes.Buffer
	max      int
	overflow bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if room := c.max - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
			c.overflow = true
		} else {
			c.buf.Write(p)
		}
	} else if len(p) > 0 {
		c.overflow = true
	}
	return len(p), nil
}

// complete reports whether the whole response fit in the buffer.
func (c *cappedBuffer) complete() bool { return !c.overflow }

// responseDetail returns the detail derived from the response for the routes
// in auditResponseDetail (the permissions the console key ended up with).
func responseDetail(r *http.Request, resp *cappedBuffer) map[string]any {
	if resp == nil || !resp.complete() || !auditResponseDetail.MatchString(r.URL.Path) {
		return nil
	}
	var body bucketKeyPermsResponse
	if json.Unmarshal(resp.buf.Bytes(), &body) != nil {
		return nil
	}
	return map[string]any{
		"read":    body.Permissions.Read,
		"write":   body.Permissions.Write,
		"owner":   body.Permissions.Owner,
		"changed": body.Changed,
	}
}

// garageErrors reports whether the (complete) response is a Garage
// MultiResponse whose "error" map is non-empty, i.e. at least one node
// failed although the proxy answered 200.
func garageErrors(resp *cappedBuffer) bool {
	if resp == nil || !resp.complete() || resp.buf.Len() == 0 {
		return false
	}
	var multi struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(resp.buf.Bytes(), &multi) != nil || len(multi.Error) == 0 {
		return false
	}
	var errs map[string]json.RawMessage
	if json.Unmarshal(multi.Error, &errs) != nil {
		return false
	}
	return len(errs) > 0
}

// truncateUTF8 cuts s to at most n bytes without splitting a UTF-8 sequence.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// auditQuery returns the allowlisted query parameters of r.
func auditQuery(r *http.Request) map[string]string {
	q := r.URL.Query()
	out := map[string]string{}
	for k, vs := range q {
		if !auditQueryAllowlist[k] || len(vs) == 0 {
			continue
		}
		out[k] = truncateUTF8(vs[0], auditMaxValueBytes)
	}
	return out
}

// auditRoute returns the chi route pattern and URL params of r. It must be
// called after the router has handled r so the route context is populated.
func auditRoute(r *http.Request) (string, map[string]string) {
	params := map[string]string{}
	rctx := chi.RouteContext(r.Context())
	if rctx == nil {
		return "", params
	}
	for i, k := range rctx.URLParams.Keys {
		// "*" is chi's mount wildcard (the unrouted remainder of the path,
		// e.g. when auth/CSRF rejects a request before the subrouter runs);
		// it duplicates path, so it is skipped.
		if k == "" || k == "*" || i >= len(rctx.URLParams.Values) {
			continue
		}
		params[k] = truncateUTF8(rctx.URLParams.Values[i], auditMaxValueBytes)
	}
	return rctx.RoutePattern(), params
}

// auditRecord collects what the middleware learns about one audited request.
type auditRecord struct {
	user     string
	detail   map[string]any
	response *cappedBuffer
}

// logAudit writes the msg="audit" line for a finished mutating request.
func logAudit(ctx context.Context, r *http.Request, rec *auditRecord, status int, elapsed time.Duration, panicked bool) {
	route, params := auditRoute(r)
	attrs := make([]any, 0, 24)
	if rec.user != "" {
		attrs = append(attrs, "user", rec.user)
	}
	attrs = append(attrs,
		"method", r.Method,
		"path", r.URL.Path,
		"route", route,
		"status", status,
		"duration_ms", elapsed.Milliseconds(),
		"params", params,
		"query", auditQuery(r),
	)
	detail := rec.detail
	if rd := responseDetail(r, rec.response); len(rd) > 0 {
		detail = rd
	}
	if len(detail) > 0 {
		attrs = append(attrs, "detail", detail)
	}
	if garageErrors(rec.response) {
		attrs = append(attrs, "garageErrors", true)
	}
	if panicked {
		attrs = append(attrs, "panic", true)
	}
	slog.InfoContext(ctx, "audit", attrs...)
}

// auditAuthEvent writes the msg="audit" line for a login or logout, which the
// middleware skips (the /api/auth/* routes carry OAuth state, not resources).
func auditAuthEvent(r *http.Request, event, user string) {
	slog.InfoContext(r.Context(), "audit",
		"event", event,
		"user", user,
		"method", r.Method,
		"path", r.URL.Path,
	)
}
