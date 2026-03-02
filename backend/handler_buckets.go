package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
)

// handleListBuckets proxies GET /api/buckets to Garage GET /v2/ListBuckets.
func handleListBuckets(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/v2/ListBuckets")
}

// handleCreateBucket proxies POST /api/buckets to Garage POST /v2/CreateBucket.
func handleCreateBucket(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		const garagePath = "/v2/CreateBucket"
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodPost, garagePath, r.Body)
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
		garagePath := "/v2/UpdateBucket?id=" + url.QueryEscape(id)
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodPost, garagePath, r.Body)
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

// handleDeleteBucket proxies DELETE /api/buckets/{id} to Garage POST /v2/DeleteBucket?id={id}.
func handleDeleteBucket(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		garagePath := "/v2/DeleteBucket?id=" + url.QueryEscape(id)
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodPost, garagePath, nil)
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

		const garagePath = "/v2/AllowBucketKey"
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodPost, garagePath, pr)
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

		const garagePath = "/v2/DenyBucketKey"
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodPost, garagePath, pr)
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
