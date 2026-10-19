package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
)

// handleListBuckets (GET /api/buckets) lives in handler_lists.go.

// handleCreateBucket proxies POST /api/buckets to Garage POST /v2/CreateBucket.
func handleCreateBucket(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		proxyGarageMutation(w, r, garageAdmin, "/v2/CreateBucket", r.Body)
	}
}

// handleGetBucket proxies GET /api/buckets/{id} to Garage GET /v2/GetBucketInfo?id={id}.
func handleGetBucket(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		garagePath := "/v2/GetBucketInfo?id=" + url.QueryEscape(id)
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodGet, garagePath, nil)
		if err != nil {
			slog.ErrorContext(r.Context(), "garage request failed", "path", garagePath, "error", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		ct := resp.Header.Get("Content-Type")
		if ct == "" {
			ct = "application/json"
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(resp.StatusCode)
		if _, err := io.Copy(w, resp.Body); err != nil {
			slog.ErrorContext(r.Context(), "failed to stream garage response", "path", garagePath, "error", err)
		}
	}
}

// handleUpdateBucket proxies PUT /api/buckets/{id} to Garage POST /v2/UpdateBucket?id={id}.
func handleUpdateBucket(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		proxyGarageMutation(w, r, garageAdmin, "/v2/UpdateBucket?id="+url.QueryEscape(id), r.Body)
	}
}

// handleDeleteBucket proxies DELETE /api/buckets/{id} to Garage POST /v2/DeleteBucket?id={id}.
func handleDeleteBucket(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		proxyGarageMutation(w, r, garageAdmin, "/v2/DeleteBucket?id="+url.QueryEscape(id), nil)
	}
}

// handleGrantBucketKey proxies POST /api/buckets/{id}/keys to Garage POST /v2/AllowBucketKey.
// It reads the request body, injects the bucket ID from the URL path, and forwards to Garage.
func handleGrantBucketKey(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucketID := chi.URLParam(r, "id")

		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		body["bucketId"] = bucketID

		pr, pw := io.Pipe()
		go func() {
			defer pw.Close()
			json.NewEncoder(pw).Encode(body)
		}()

		proxyGarageMutation(w, r, garageAdmin, "/v2/AllowBucketKey", pr)
	}
}

// handleRevokeBucketKey proxies DELETE /api/buckets/{id}/keys/{kid} to Garage POST /v2/DenyBucketKey.
// It constructs the deny request body from the URL path parameters.
func handleRevokeBucketKey(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucketID := chi.URLParam(r, "id")
		keyID := chi.URLParam(r, "kid")

		body := map[string]interface{}{
			"bucketId":    bucketID,
			"accessKeyId": keyID,
			"permissions": map[string]bool{
				"read":  true,
				"write": true,
				"owner": true,
			},
		}

		pr, pw := io.Pipe()
		go func() {
			defer pw.Close()
			json.NewEncoder(pw).Encode(body)
		}()

		proxyGarageMutation(w, r, garageAdmin, "/v2/DenyBucketKey", pr)
	}
}

// maxCleanupBodyBytes bounds the tiny JSON body of the cleanup endpoint.
const maxCleanupBodyBytes = 4 << 10

// handleCleanupIncompleteUploads proxies POST /api/buckets/{id}/cleanup-uploads
// (body {"olderThanSecs": N}) to Garage POST /v2/CleanupIncompleteUploads,
// injecting the bucket ID from the URL. Garage answers {"uploadsDeleted": N}.
// The list caches are cleared on success because the bucket list shows the
// unfinished-upload count.
func handleCleanupIncompleteUploads(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucketID := chi.URLParam(r, "id")

		var req struct {
			// Pointer so that a missing field is rejected instead of
			// silently meaning "delete every unfinished upload".
			OlderThanSecs *int64 `json:"olderThanSecs"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxCleanupBodyBytes))
		if err := dec.Decode(&req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
			return
		}
		if req.OlderThanSecs == nil || *req.OlderThanSecs < 0 {
			writeJSONError(w, http.StatusBadRequest, "olderThanSecs must be a non-negative integer")
			return
		}

		body, err := json.Marshal(map[string]any{
			"bucketId":      bucketID,
			"olderThanSecs": *req.OlderThanSecs,
		})
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		proxyGarageMutation(w, r, garageAdmin, "/v2/CleanupIncompleteUploads", bytes.NewReader(body))
	}
}
