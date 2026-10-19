package main

import "sort"

// nodeBlockStats is one node's block manager stats from GetNodeStatistics.
type nodeBlockStats struct {
	NodeID         string `json:"nodeId"`
	ResyncQueueLen int64  `json:"resyncQueueLen"`
	ResyncErrors   int64  `json:"resyncErrors"`
}

// maintenanceMetrics is the aggregated GetNodeStatistics?node=* answer used
// by GET /api/cluster/storage-health (the dashboard and the repair page).
//
// ResyncQueueLength and ResyncErrored are sums over every node that reported
// blockManagerStats; Nodes carries the per-node breakdown and NodeErrors the
// nodes that could not be reached or did not report the stats.
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
