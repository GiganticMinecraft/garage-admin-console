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
//
// It must be registered outside middleware.Recoverer so the 500 written for
// a panicking handler is the status that gets logged. The lines are written
// from a defer, so even a panic that escapes Recoverer is still logged.
func accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		start := time.Now()

		// Resolve the user before the handler runs: logout / callback
		// rewrite the session cookie, and we want the caller's identity.
		user := sessionUser(r)
		var audit *auditRecord
		if isAuditedRequest(r) {
			audit = &auditRecord{
				user:     user,
				detail:   auditDetail(r),
				response: &cappedBuffer{max: maxAuditBodyBytes},
			}
			ww.Tee(audit.response)
		}

		completed := false
		defer func() {
			elapsed := time.Since(start)
			status := ww.Status()
			panicked := !completed
			if panicked && status == 0 {
				status = http.StatusInternalServerError
			}

			attrs := make([]any, 0, 16)
			if user != "" {
				attrs = append(attrs, "user", user)
			}
			attrs = append(attrs,
				"method", r.Method,
				"path", r.URL.Path,
				"status", status,
				"duration_ms", elapsed.Milliseconds(),
				"bytes", ww.BytesWritten(),
			)
			if panicked {
				attrs = append(attrs, "panic", true)
			}
			slog.InfoContext(r.Context(), "request", attrs...)

			if audit != nil {
				logAudit(r.Context(), r, audit, status, elapsed, panicked)
			}
		}()

		next.ServeHTTP(ww, r)
		completed = true
	})
}
