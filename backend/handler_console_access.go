package main

import (
	"bytes"
	"io"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
)

// consoleKeyIDFromEnv is the access key ID of the S3 key the console itself
// uses for the object browser (GARAGE_S3_ACCESS_KEY). It is not a secret: it
// is also listed by GET /api/keys. GARAGE_S3_SECRET_KEY is never exposed.
func consoleKeyIDFromEnv() string {
	return os.Getenv("GARAGE_S3_ACCESS_KEY")
}

// maxConsoleAccessBodyBytes bounds the (empty) body of the console-access
// endpoint. One byte over the limit is read so oversized bodies are rejected.
const maxConsoleAccessBodyBytes = 1 << 10

// handleGrantConsoleAccess handles POST /api/buckets/{id}/console-access:
// grants read + write on the bucket to the console's own S3 key, enough for
// the object browser to list, download, upload and delete. Owner is left as
// it is (never added). The key is fixed by the server configuration; the
// request cannot name another key, so the body must be empty or "{}".
//
// The response has the same shape as PUT /api/buckets/{id}/keys/{kid};
// changed is false when the key already had read and write.
func handleGrantConsoleAccess(garageAdmin *GarageAdminClient, consoleKeyID string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if consoleKeyID == "" {
			writeJSONError(w, http.StatusServiceUnavailable, "the console's S3 key (GARAGE_S3_ACCESS_KEY) is not configured")
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, maxConsoleAccessBodyBytes+1))
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "failed to read request body")
			return
		}
		if body := bytes.TrimSpace(raw); len(body) != 0 && string(body) != "{}" {
			writeJSONError(w, http.StatusBadRequest, "request body must be empty: the console's own key is always used")
			return
		}

		resp, path, err := setBucketKeyPermissions(r.Context(), garageAdmin, chi.URLParam(r, "id"), consoleKeyID,
			func(current bucketKeyPerm) bucketKeyPerm {
				return bucketKeyPerm{Read: true, Write: true, Owner: current.Owner}
			})
		if err != nil {
			writeGarageCallError(w, r, path, err)
			return
		}
		writeJSON(w, resp)
	}
}
