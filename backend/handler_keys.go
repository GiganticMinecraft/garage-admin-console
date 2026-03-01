package main

import (
	"io"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// handleListKeys proxies GET /api/keys to Garage GET /v2/key?list.
func handleListKeys(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/v2/key?list")
}

// handleCreateKey proxies POST /api/keys to Garage POST /v2/key.
func handleCreateKey(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		const garagePath = "/v2/key"
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodPost, garagePath, r.Body)
		if err != nil {
			slog.Error("garage request failed", "path", garagePath, "error", err)
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
			slog.Error("failed to stream garage response", "path", garagePath, "error", err)
		}
	}
}

// handleGetKey proxies GET /api/keys/{id} to Garage GET /v2/key?id={id}.
func handleGetKey(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		garagePath := "/v2/key?id=" + id
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodGet, garagePath, nil)
		if err != nil {
			slog.Error("garage request failed", "path", garagePath, "error", err)
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
			slog.Error("failed to stream garage response", "path", garagePath, "error", err)
		}
	}
}

// handleUpdateKey proxies PUT /api/keys/{id} to Garage POST /v2/key?id={id}.
// Note: Garage uses POST for key updates.
func handleUpdateKey(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		garagePath := "/v2/key?id=" + id
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodPost, garagePath, r.Body)
		if err != nil {
			slog.Error("garage request failed", "path", garagePath, "error", err)
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
			slog.Error("failed to stream garage response", "path", garagePath, "error", err)
		}
	}
}

// handleDeleteKey proxies DELETE /api/keys/{id} to Garage DELETE /v2/key?id={id}.
func handleDeleteKey(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		garagePath := "/v2/key?id=" + id
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodDelete, garagePath, nil)
		if err != nil {
			slog.Error("garage request failed", "path", garagePath, "error", err)
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
			slog.Error("failed to stream garage response", "path", garagePath, "error", err)
		}
	}
}
