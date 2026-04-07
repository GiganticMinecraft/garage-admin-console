package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
)

// handleListBlockErrors proxies GET /api/blocks/errors to Garage GET /v2/ListBlockErrors?node=*.
// The Garage response is { "success": { "nodeId": [...blockErrors] }, "error": {} }.
// success[nodeId] is a plain array of BlockError objects (Vec<BlockError>).
// We flatten all block errors into a single array, injecting "nodeId" into each entry.
func handleListBlockErrors(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		const garagePath = "/v2/ListBlockErrors?node=*"
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodGet, garagePath, nil)
		if err != nil {
			slog.ErrorContext(r.Context(), "garage request failed", "path", garagePath, "error", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(resp.StatusCode)
			json.NewEncoder(w).Encode(map[string]string{"error": "upstream error"})
			return
		}

		var multiResp struct {
			Success map[string][]json.RawMessage `json:"success"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&multiResp); err != nil {
			slog.ErrorContext(r.Context(), "failed to decode ListBlockErrors response", "error", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}

		var allErrors []json.RawMessage
		for nodeID, blockErrors := range multiResp.Success {
			for _, raw := range blockErrors {
				var m map[string]any
				if err := json.Unmarshal(raw, &m); err != nil {
					continue
				}
				m["nodeId"] = nodeID
				enriched, err := json.Marshal(m)
				if err != nil {
					continue
				}
				allErrors = append(allErrors, enriched)
			}
		}

		w.Header().Set("Content-Type", "application/json")
		if allErrors == nil {
			allErrors = []json.RawMessage{}
		}
		json.NewEncoder(w).Encode(allErrors)
	}
}

// handleGetBlockInfo proxies POST /api/blocks/info to Garage POST /v2/GetBlockInfo?node=*.
// The MultiResponse is forwarded as-is so the frontend can display per-node results.
func handleGetBlockInfo(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGaragePOST(garageAdmin, "/v2/GetBlockInfo?node=*")
}

// handlePurgeBlocks proxies POST /api/blocks/purge to Garage POST /v2/PurgeBlocks?node=*.
// The MultiResponse (including blocksPurged, objectsDeleted, etc.) is forwarded as-is.
func handlePurgeBlocks(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGaragePOST(garageAdmin, "/v2/PurgeBlocks?node=*")
}

// handleRetryBlockResync proxies POST /api/blocks/resync to Garage POST /v2/RetryBlockResync?node=*.
// The MultiResponse (including count per node) is forwarded as-is.
func handleRetryBlockResync(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGaragePOST(garageAdmin, "/v2/RetryBlockResync?node=*")
}

// proxyGaragePOST forwards a POST request body to the Garage Admin API and
// streams the response back to the client.
func proxyGaragePOST(garageAdmin *GarageAdminClient, garagePath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
