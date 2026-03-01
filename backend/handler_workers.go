package main

import (
	"io"
	"log/slog"
	"net/http"
	"strings"
)

// handleListWorkers proxies GET /api/workers to Garage POST /v2/ListWorkers.
func handleListWorkers(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		const garagePath = "/v2/ListWorkers?node=*"
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodPost, garagePath, strings.NewReader("{}"))
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
