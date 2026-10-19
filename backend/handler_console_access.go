package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"

	"github.com/go-chi/chi/v5"
)

// consoleKeyIDFromEnv is the access key ID of the S3 key the console itself
// uses for the object browser (GARAGE_S3_ACCESS_KEY). It is not a secret: it
// is also listed by GET /api/keys. GARAGE_S3_SECRET_KEY is never exposed.
func consoleKeyIDFromEnv() string {
	return os.Getenv("GARAGE_S3_ACCESS_KEY")
}

// consoleAccessPerms is what POST /api/buckets/{id}/console-access grants:
// enough for the object browser to list, download, upload and delete.
// Owner is deliberately not included.
var consoleAccessPerms = bucketKeyPerm{Read: true, Write: true}

// handleGrantConsoleAccess handles POST /api/buckets/{id}/console-access:
// grants read + write on the bucket to the console's own S3 key via Garage
// AllowBucketKey. The key is fixed by the server configuration; the request
// cannot name another key, so the body must be empty or "{}".
//
// The response has the same shape as PUT /api/buckets/{id}/keys/{kid};
// changed is false when the key already had read and write.
func handleGrantConsoleAccess(garageAdmin *GarageAdminClient, consoleKeyID string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if consoleKeyID == "" {
			writeJSONError(w, http.StatusServiceUnavailable, "the console's S3 key (GARAGE_S3_ACCESS_KEY) is not configured")
			return
		}
		if r.ContentLength != 0 {
			var empty struct{}
			dec := json.NewDecoder(io.LimitReader(r.Body, 1<<10))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&empty); err != nil && !errors.Is(err, io.EOF) {
				writeJSONError(w, http.StatusBadRequest, "request body must be empty: the console's own key is always used")
				return
			}
		}

		bucketID := chi.URLParam(r, "id")
		infoPath := "/v2/GetBucketInfo?id=" + url.QueryEscape(bucketID)
		var info garageBucketKeys
		if err := garageGetJSON(r.Context(), garageAdmin, infoPath, &info); err != nil {
			writeGarageCallError(w, r, infoPath, err)
			return
		}
		if info.ID != "" {
			bucketID = info.ID
		}
		current := info.permsOf(consoleKeyID)
		if current.Read && current.Write {
			writeConsoleAccess(w, bucketKeyPermsResponse{
				BucketID:    bucketID,
				AccessKeyID: consoleKeyID,
				Permissions: current,
				Changed:     false,
			})
			return
		}

		const allowPath = "/v2/AllowBucketKey"
		body, err := json.Marshal(map[string]any{
			"bucketId":    bucketID,
			"accessKeyId": consoleKeyID,
			"permissions": consoleAccessPerms,
		})
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		var after garageBucketKeys
		if err := garageRequestJSON(r.Context(), garageAdmin, http.MethodPost, allowPath, body, &after); err != nil {
			writeGarageCallError(w, r, allowPath, err)
			return
		}
		invalidateListCaches()

		writeConsoleAccess(w, bucketKeyPermsResponse{
			BucketID:    bucketID,
			AccessKeyID: consoleKeyID,
			Permissions: after.permsOf(consoleKeyID),
			Changed:     true,
		})
	}
}

func writeConsoleAccess(w http.ResponseWriter, resp bucketKeyPermsResponse) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
