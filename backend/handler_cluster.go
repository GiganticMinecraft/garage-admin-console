package main

import (
	"io"
	"log/slog"
	"net/http"
)

// proxyGarageGET is a helper that proxies a GET request to the Garage Admin API
// and streams the JSON response back to the client.
func proxyGarageGET(garageAdmin *GarageAdminClient, garagePath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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

// handleClusterHealth proxies GET /api/cluster/health to Garage GET /health.
func handleClusterHealth(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/health")
}

// handleClusterStatus proxies GET /api/cluster/status to Garage GET /status.
func handleClusterStatus(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/status")
}

// handleClusterLayout proxies GET /api/cluster/layout to Garage GET /v2/layout.
func handleClusterLayout(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/v2/layout")
}

// handleApplyLayout proxies POST /api/cluster/layout to Garage POST /v2/layout.
// The request body is forwarded as-is.
func handleApplyLayout(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodPost, "/v2/layout", r.Body)
		if err != nil {
			slog.Error("garage request failed", "path", "/v2/layout", "error", err)
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
			slog.Error("failed to stream garage response", "path", "/v2/layout", "error", err)
		}
	}
}
