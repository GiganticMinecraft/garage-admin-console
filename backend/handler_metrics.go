package main

import (
	"bufio"
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
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
// data. CorruptionCounter only exists as a Prometheus metric, which Garage
// serves per node, so it reflects the node behind the admin endpoint. It is 0
// when /metrics answered but has never exported the counter (OTel registers
// it lazily), and null when /metrics was unavailable (e.g. metrics_token is
// configured) or could not be read.
type maintenanceMetrics struct {
	ResyncQueueLength int64             `json:"resyncQueueLength"`
	ResyncErrored     int64             `json:"resyncErroredBlocks"`
	CorruptionCounter *float64          `json:"corruptionCounter"`
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

// parseCorruptionCounter extracts block_corruption_counter from Prometheus text.
// Returns 0 when the body was read fully but the metric is absent, and an error
// when the body could not be read to the end (the value is then unknown).
func parseCorruptionCounter(scanner *bufio.Scanner) (float64, error) {
	const prefix = "block_corruption_counter"
	var result float64
	for scanner.Scan() {
		line := scanner.Text()
		if len(line) == 0 || line[0] == '#' || !strings.HasPrefix(line, prefix) {
			continue
		}
		rest := line[len(prefix):]
		// Skip label block if present: metric{...} value
		if len(rest) > 0 && rest[0] == '{' {
			idx := strings.IndexByte(rest, '}')
			if idx < 0 {
				continue
			}
			rest = rest[idx+1:]
		}
		if len(rest) == 0 || rest[0] != ' ' {
			continue
		}
		if val, err := strconv.ParseFloat(strings.TrimSpace(rest[1:]), 64); err == nil {
			result = val
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}
	return result, nil
}

// handleMaintenanceMetrics serves GET /api/metrics for the repair page.
// Resync queue length and resync errors come from GetNodeStatistics?node=*
// (cluster-wide); the corruption counter comes from the admin node's /metrics.
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

		// Corruption counter: best effort, never fails the whole response.
		if mresp, err := garageAdmin.doRequest(r.Context(), http.MethodGet, "/metrics", nil); err != nil {
			slog.WarnContext(r.Context(), "garage /metrics unavailable", "error", err)
		} else {
			if mresp.StatusCode == http.StatusOK {
				if v, err := parseCorruptionCounter(bufio.NewScanner(mresp.Body)); err != nil {
					slog.WarnContext(r.Context(), "failed to read garage /metrics body", "error", err)
				} else {
					result.CorruptionCounter = &v
				}
			} else {
				slog.WarnContext(r.Context(), "garage /metrics returned non-200", "status", mresp.StatusCode)
			}
			mresp.Body.Close()
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}
