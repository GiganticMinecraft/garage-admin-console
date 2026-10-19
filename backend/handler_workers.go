package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"strings"
)

// workerEntry is one worker from one node, tagged with the node it runs on.
// Worker IDs are per-node counters, so (nodeId, id) is the unique key.
// The wire shape is produced by MarshalJSON (raw worker fields + nodeId);
// nodeID and id are only used for sorting.
type workerEntry struct {
	nodeID string
	id     int64
	raw    map[string]any
}

func (w workerEntry) MarshalJSON() ([]byte, error) {
	m := make(map[string]any, len(w.raw)+1)
	for k, v := range w.raw {
		m[k] = v
	}
	m["nodeId"] = w.nodeID
	return json.Marshal(m)
}

// workersResponse is what GET /api/workers returns: every worker from every
// node that answered, plus the error message for each node that did not, so
// the UI can show partial results honestly instead of silently dropping nodes.
type workersResponse struct {
	Workers []workerEntry     `json:"workers"`
	Errors  map[string]string `json:"errors"`
}

// flattenWorkers converts Garage's MultiResponse for ListWorkers into a
// deterministic list: sorted by node ID then worker ID.
func flattenWorkers(success map[string][]json.RawMessage, errors map[string]string) workersResponse {
	out := workersResponse{Workers: []workerEntry{}, Errors: map[string]string{}}
	for nodeID, workers := range success {
		for _, raw := range workers {
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				continue
			}
			var id int64
			if v, ok := m["id"].(float64); ok {
				id = int64(v)
			}
			out.Workers = append(out.Workers, workerEntry{nodeID: nodeID, id: id, raw: m})
		}
	}
	sort.SliceStable(out.Workers, func(i, j int) bool {
		if out.Workers[i].nodeID != out.Workers[j].nodeID {
			return out.Workers[i].nodeID < out.Workers[j].nodeID
		}
		return out.Workers[i].id < out.Workers[j].id
	})
	for nodeID, msg := range errors {
		out.Errors[nodeID] = msg
	}
	return out
}

// handleListWorkers proxies GET /api/workers to Garage POST /v2/ListWorkers?node=*.
// The Garage response is { "success": { "nodeId": [...workers] }, "error": { "nodeId": "msg" } }.
func handleListWorkers(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		const garagePath = "/v2/ListWorkers?node=*"
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodPost, garagePath, strings.NewReader("{}"))
		if err != nil {
			slog.ErrorContext(r.Context(), "garage request failed", "path", garagePath, "error", err)
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
			Success map[string][]json.RawMessage `json:"success"`
			Error   map[string]string            `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&multiResp); err != nil {
			slog.ErrorContext(r.Context(), "failed to decode ListWorkers response", "error", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}
		for nodeID, msg := range multiResp.Error {
			slog.WarnContext(r.Context(), "ListWorkers failed on node", "node", nodeID, "error", msg)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(flattenWorkers(multiResp.Success, multiResp.Error))
	}
}
