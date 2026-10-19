package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
)

// nodeBlockStats is the per-node slice of the maintenance metrics.
type nodeBlockStats struct {
	NodeID         string `json:"nodeId"`
	ResyncQueueLen int64  `json:"resyncQueueLen"`
	ResyncErrors   int64  `json:"resyncErrors"`
}

// maintenanceMetrics holds the block-related signals shown on the repair page.
//
// ResyncQueueLength and ResyncErrored are cluster-wide sums over every node
// that answered GetNodeStatistics; Nodes carries the per-node breakdown and
// NodeErrors the nodes that could not be reached, so the UI can flag partial
// data.
//
// The scrub corruption count is not part of this response: the repair page
// reads the persisted per-node worker variable scrub-corruptions_detected
// from GET /api/cluster/storage-health, like the dashboard. (Prometheus'
// block_corruption_counter counts corruptions seen on block reads, lives in
// memory and resets on restart, so it is not the same number.)
type maintenanceMetrics struct {
	ResyncQueueLength int64             `json:"resyncQueueLength"`
	ResyncErrored     int64             `json:"resyncErroredBlocks"`
	Nodes             []nodeBlockStats  `json:"nodes"`
	NodeErrors        map[string]string `json:"nodeErrors"`
}

// nodeStatisticsMulti is the subset of Garage's GetNodeStatistics MultiResponse we use.
type nodeStatisticsMulti struct {
	Success map[string]struct {
		BlockManagerStats *struct {
			ResyncQueueLen int64 `json:"resyncQueueLen"`
			ResyncErrors   int64 `json:"resyncErrors"`
		} `json:"blockManagerStats"`
	} `json:"success"`
	Error map[string]string `json:"error"`
}

// aggregateNodeStatistics sums the block manager stats across nodes and
// returns a deterministic per-node breakdown (sorted by node ID). Nodes that
// answered but run a Garage too old to report blockManagerStats (< v2.3.0)
// are listed under NodeErrors so the sum is not silently short.
func aggregateNodeStatistics(multi nodeStatisticsMulti) maintenanceMetrics {
	out := maintenanceMetrics{Nodes: []nodeBlockStats{}, NodeErrors: map[string]string{}}
	for nodeID, s := range multi.Success {
		if s.BlockManagerStats == nil {
			out.NodeErrors[nodeID] = "blockManagerStats not reported (Garage < v2.3.0?)"
			continue
		}
		out.Nodes = append(out.Nodes, nodeBlockStats{
			NodeID:         nodeID,
			ResyncQueueLen: s.BlockManagerStats.ResyncQueueLen,
			ResyncErrors:   s.BlockManagerStats.ResyncErrors,
		})
		out.ResyncQueueLength += s.BlockManagerStats.ResyncQueueLen
		out.ResyncErrored += s.BlockManagerStats.ResyncErrors
	}
	for nodeID, msg := range multi.Error {
		out.NodeErrors[nodeID] = msg
	}
	sort.Slice(out.Nodes, func(i, j int) bool { return out.Nodes[i].NodeID < out.Nodes[j].NodeID })
	return out
}

// handleMaintenanceMetrics serves GET /api/metrics for the repair page.
// Resync queue length and resync errors come from GetNodeStatistics?node=*
// (cluster-wide).
func handleMaintenanceMetrics(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		const statsPath = "/v2/GetNodeStatistics?node=*"
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodGet, statsPath, nil)
		if err != nil {
			slog.ErrorContext(r.Context(), "garage request failed", "path", statsPath, "error", err)
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

		var multi nodeStatisticsMulti
		if err := json.NewDecoder(resp.Body).Decode(&multi); err != nil {
			slog.ErrorContext(r.Context(), "failed to decode GetNodeStatistics response", "error", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}
		result := aggregateNodeStatistics(multi)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}
