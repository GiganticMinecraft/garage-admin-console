package main

import (
	"net/http"
	"net/url"
	"regexp"

	"github.com/go-chi/chi/v5"
)

// bucketIDPattern matches a full Garage bucket ID: 32 bytes, hex encoded.
// InspectObject only takes an ID (Garage's parse_bucket_id hex-decodes it into
// a 32-byte UUID), never a global or local alias, so anything else is rejected
// here instead of being sent upstream.
var bucketIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

// handleInspectObject proxies GET /api/buckets/{id}/objects/inspect?key=... to
// Garage GET /v2/InspectObject?bucketId=...&key=..., which returns the object's
// versions (upload state, size, etag, encryption, headers) and their data
// blocks. Garage's status is passed through as-is, so a missing object (or a
// bucket ID that has no such object) stays a 404 (NoSuchKey).
func handleInspectObject(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if !bucketIDPattern.MatchString(id) {
			writeJSONError(w, http.StatusBadRequest, "invalid bucket id: must be a 64-character hex bucket ID (aliases are not accepted)")
			return
		}
		key := r.URL.Query().Get("key")
		if key == "" {
			writeJSONError(w, http.StatusBadRequest, "key is required")
			return
		}
		q := url.Values{}
		q.Set("bucketId", id)
		q.Set("key", key)
		proxyGarageRequest(w, r, garageAdmin, http.MethodGet, "/v2/InspectObject?"+q.Encode(), nil)
	}
}
