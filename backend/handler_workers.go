package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
)

// handleListWorkers proxies GET /api/workers to Garage POST /v2/ListWorkers.
// The Garage response is { "success": { "nodeId": [...workers] }, "error": {} }.
// We flatten all workers into a single array for the frontend.
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

		if resp.StatusCode != http.StatusOK {
			w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
			w.WriteHeader(resp.StatusCode)
			json.NewEncoder(w).Encode(map[string]string{"error": "upstream error"})
			return
		}

		var multiResp struct {
			Success map[string]json.RawMessage `json:"success"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&multiResp); err != nil {
			slog.Error("failed to decode ListWorkers response", "error", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}

		var allWorkers []json.RawMessage
		for _, nodeWorkers := range multiResp.Success {
			var workers []json.RawMessage
			if err := json.Unmarshal(nodeWorkers, &workers); err != nil {
				continue
			}
			allWorkers = append(allWorkers, workers...)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(allWorkers)
	}
}
