package main

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// accessLog is a middleware that logs each HTTP request with method, path,
// status, duration, and bytes written, plus the GitHub login of the session
// ("user", omitted when unauthenticated). Because the logger uses
// traceHandler, trace_id and span_id are automatically injected from the
// request context.
//
// Mutating requests additionally get a msg="audit" line (see
// middleware_audit.go).
func accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		start := time.Now()

		// Resolve the user before the handler runs: logout / callback
		// rewrite the session cookie, and we want the caller's identity.
		user := sessionUser(r)
		audited := isAuditedRequest(r)
		var detail map[string]string
		if audited {
			detail = auditDetail(r)
		}

		next.ServeHTTP(ww, r)
		elapsed := time.Since(start)

		attrs := make([]any, 0, 14)
		if user != "" {
			attrs = append(attrs, "user", user)
		}
		attrs = append(attrs,
			"method", r.Method,
			"path", r.URL.Path,
			"status", ww.Status(),
			"duration_ms", elapsed.Milliseconds(),
			"bytes", ww.BytesWritten(),
		)
		slog.InfoContext(r.Context(), "request", attrs...)

		if audited {
			logAudit(r.Context(), r, user, ww.Status(), elapsed, detail)
		}
	})
}
