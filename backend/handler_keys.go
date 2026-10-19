package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
)

// handleListKeys (GET /api/keys) lives in handler_lists.go.

// handleCreateKey proxies POST /api/keys to Garage POST /v2/CreateKey.
func handleCreateKey(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		const garagePath = "/v2/CreateKey"
		// The response carries the new secret: keep it out of caches.
		w.Header().Set("Cache-Control", "no-store")
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
		if resp.StatusCode < 300 && r.Method != http.MethodGet {
			invalidateListCaches()
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(resp.StatusCode)
		if _, err := io.Copy(w, resp.Body); err != nil {
			slog.ErrorContext(r.Context(), "failed to stream garage response", "path", garagePath, "error", err)
		}
	}
}

// handleGetKey proxies GET /api/keys/{id} to Garage GET /v2/GetKeyInfo?id={id}.
// Passing ?showSecretKey=true asks Garage to include secretAccessKey in the
// response so operators can retrieve a key's secret from the UI.
func handleGetKey(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		garagePath := "/v2/GetKeyInfo?id=" + url.QueryEscape(id)
		if r.URL.Query().Get("showSecretKey") == "true" {
			garagePath += "&showSecretKey=true"
			// The response carries the secret: keep it out of browser and proxy caches.
			w.Header().Set("Cache-Control", "no-store")
		}
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
		if resp.StatusCode < 300 && r.Method != http.MethodGet {
			invalidateListCaches()
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(resp.StatusCode)
		if _, err := io.Copy(w, resp.Body); err != nil {
			slog.ErrorContext(r.Context(), "failed to stream garage response", "path", garagePath, "error", err)
		}
	}
}

// handleUpdateKey proxies PUT /api/keys/{id} to Garage POST /v2/UpdateKey?id={id}.
// Note: Garage uses POST for key updates.
func handleUpdateKey(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		garagePath := "/v2/UpdateKey?id=" + url.QueryEscape(id)
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
		if resp.StatusCode < 300 && r.Method != http.MethodGet {
			invalidateListCaches()
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(resp.StatusCode)
		if _, err := io.Copy(w, resp.Body); err != nil {
			slog.ErrorContext(r.Context(), "failed to stream garage response", "path", garagePath, "error", err)
		}
	}
}

// handleDeleteKey proxies DELETE /api/keys/{id} to Garage POST /v2/DeleteKey?id={id}.
func handleDeleteKey(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		garagePath := "/v2/DeleteKey?id=" + url.QueryEscape(id)
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
		if resp.StatusCode < 300 && r.Method != http.MethodGet {
			invalidateListCaches()
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(resp.StatusCode)
		if _, err := io.Copy(w, resp.Body); err != nil {
			slog.ErrorContext(r.Context(), "failed to stream garage response", "path", garagePath, "error", err)
		}
	}
}
