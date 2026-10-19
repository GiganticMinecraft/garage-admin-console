package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
)

// blockErrorsResponse is what GET /api/blocks/errors returns: every block
// error from every node that answered (each tagged with "nodeId"), plus the
// error message for each node that did not. An empty Items with a non-empty
// NodeErrors means "nothing found on the nodes we could ask", not "no errors".
type blockErrorsResponse struct {
	Items      []json.RawMessage `json:"items"`
	NodeErrors map[string]string `json:"nodeErrors"`
}

// listBlockErrorsMulti is Garage's MultiResponse for ListBlockErrors:
// success[nodeId] is a plain array of BlockError objects (Vec<BlockError>),
// error[nodeId] the message for nodes that could not answer.
type listBlockErrorsMulti struct {
	Success map[string][]json.RawMessage `json:"success"`
	Error   map[string]string            `json:"error"`
}

// flattenBlockErrors converts the MultiResponse into a blockErrorsResponse,
// injecting "nodeId" into each entry. Items are ordered by node ID, keeping
// Garage's order within a node, so the table does not reshuffle on refetch.
func flattenBlockErrors(multi listBlockErrorsMulti) blockErrorsResponse {
	out := blockErrorsResponse{Items: []json.RawMessage{}, NodeErrors: map[string]string{}}
	nodeIDs := make([]string, 0, len(multi.Success))
	for nodeID := range multi.Success {
		nodeIDs = append(nodeIDs, nodeID)
	}
	sort.Strings(nodeIDs)
	for _, nodeID := range nodeIDs {
		for _, raw := range multi.Success[nodeID] {
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				continue
			}
			m["nodeId"] = nodeID
			enriched, err := json.Marshal(m)
			if err != nil {
				continue
			}
			out.Items = append(out.Items, enriched)
		}
	}
	for nodeID, msg := range multi.Error {
		out.NodeErrors[nodeID] = msg
	}
	return out
}

// handleListBlockErrors proxies GET /api/blocks/errors to Garage GET /v2/ListBlockErrors?node=*.
// Nodes that fail are reported under nodeErrors instead of being dropped, so
// the UI never shows "no block errors" for nodes it could not check.
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

		var multi listBlockErrorsMulti
		if err := json.NewDecoder(resp.Body).Decode(&multi); err != nil {
			slog.ErrorContext(r.Context(), "failed to decode ListBlockErrors response", "error", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}
		for nodeID, msg := range multi.Error {
			slog.WarnContext(r.Context(), "ListBlockErrors failed on node", "node", nodeID, "error", msg)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(flattenBlockErrors(multi))
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
		proxyGarageRequest(w, r, garageAdmin, http.MethodPost, garagePath, r.Body)
	}
}
