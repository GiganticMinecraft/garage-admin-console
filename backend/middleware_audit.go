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

	"github.com/go-chi/chi/v5"
)

// Audit logging.
//
// Every mutating request (POST / PUT / PATCH / DELETE, except the
// /api/auth/* login/logout flow) emits an extra INFO line with msg "audit"
// carrying who did what to which resource:
//
//	user, method, path, route, status, duration_ms, params, query, detail
//
// (trace_id / span_id are added by traceHandler when a span is active.)
//
// The request body is never logged, because it can carry secrets (key
// secrets, admin tokens, ...). The only exceptions are a few allowlisted
// fields from small JSON bodies of maintenance endpoints, see auditDetail.
// Headers (Authorization, Cookie) are never logged either.

// maxAuditBodyBytes bounds how much of a request body the audit middleware
// reads to extract detail fields. Larger bodies are passed through untouched
// and no detail is recorded.
const maxAuditBodyBytes = 4 << 10

// auditQueryAllowlist lists the query parameters that may appear in the audit
// line. Everything else (OAuth code/state, tokens, unknown parameters) is
// dropped so that no credential can leak through a query string.
var auditQueryAllowlist = map[string]bool{
	"node":      true,
	"id":        true,
	"key":       true,
	"prefix":    true,
	"delimiter": true,
}

var (
	auditNodeRepairPath    = regexp.MustCompile(`^/api/nodes/[^/]+/repair$`)
	auditWorkerVarPath     = regexp.MustCompile(`^/api/nodes/[^/]+/worker-variables$`)
	auditSafeToken         = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
	auditMaxQueryValueSize = 256
)

// sessionUser returns the GitHub login stored in the session cookie, or "" if
// the request is unauthenticated (or auth is not initialised). It uses
// CookieStore.New instead of Get so it neither mutates the request nor
// populates the per-request session registry used by the handlers.
func sessionUser(r *http.Request) string {
	if sessionStore == nil {
		return ""
	}
	sess, err := sessionStore.New(r, sessionName)
	if err != nil || sess == nil {
		return ""
	}
	user, _ := sess.Values[sessionKeyUser].(string)
	return user
}

// isAuditedRequest reports whether r is a mutation that must be audited.
func isAuditedRequest(r *http.Request) bool {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return false
	}
	return !strings.HasPrefix(r.URL.Path, "/api/auth/")
}

// auditDetail extracts the allowlisted, non-secret fields from the body of
// maintenance endpoints and restores r.Body so the downstream handler still
// sees the full body. It reads at most maxAuditBodyBytes; if the body is
// larger (or not the expected JSON), no detail is returned.
func auditDetail(r *http.Request) map[string]string {
	if r.Method != http.MethodPost || r.Body == nil || r.Body == http.NoBody {
		return nil
	}
	path := r.URL.Path
	var extract func([]byte) map[string]string
	switch {
	case path == "/api/repair" || auditNodeRepairPath.MatchString(path):
		extract = extractRepairType
	case auditWorkerVarPath.MatchString(path):
		extract = extractWorkerVariable
	default:
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
	if err != nil || len(buf) > maxAuditBodyBytes {
		return nil
	}
	return extract(buf)
}

// extractRepairType returns {"repairType": ...} for a LaunchRepairOperation
// body. Garage's RepairType is either a plain string ("blockRc") or a
// one-key object ({"scrub": "start"}), recorded as "scrub:start".
func extractRepairType(body []byte) map[string]string {
	var req struct {
		RepairType json.RawMessage `json:"repairType"`
	}
	if json.Unmarshal(body, &req) != nil || len(req.RepairType) == 0 {
		return nil
	}
	var s string
	if json.Unmarshal(req.RepairType, &s) == nil {
		if auditSafeToken.MatchString(s) {
			return map[string]string{"repairType": s}
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
		return map[string]string{"repairType": k + ":" + sub}
	}
	return nil
}

// extractWorkerVariable returns {"variable": name} for a SetWorkerVariable
// body. The value is intentionally not recorded.
func extractWorkerVariable(body []byte) map[string]string {
	var req struct {
		Variable string `json:"variable"`
	}
	if json.Unmarshal(body, &req) != nil {
		return nil
	}
	v := strings.TrimSpace(req.Variable)
	if !auditSafeToken.MatchString(v) {
		return nil
	}
	return map[string]string{"variable": v}
}

// auditQuery returns the allowlisted query parameters of r.
func auditQuery(r *http.Request) map[string]string {
	q := r.URL.Query()
	out := map[string]string{}
	for k, vs := range q {
		if !auditQueryAllowlist[k] || len(vs) == 0 {
			continue
		}
		v := vs[0]
		if len(v) > auditMaxQueryValueSize {
			v = v[:auditMaxQueryValueSize]
		}
		out[k] = v
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
		params[k] = rctx.URLParams.Values[i]
	}
	return rctx.RoutePattern(), params
}

// logAudit writes the msg="audit" line for a finished mutating request.
func logAudit(ctx context.Context, r *http.Request, user string, status int, elapsed time.Duration, detail map[string]string) {
	route, params := auditRoute(r)
	attrs := make([]any, 0, 20)
	if user != "" {
		attrs = append(attrs, "user", user)
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
	if len(detail) > 0 {
		attrs = append(attrs, "detail", detail)
	}
	slog.InfoContext(ctx, "audit", attrs...)
}
