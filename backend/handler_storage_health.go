package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// GET /api/cluster/storage-health exposes, per node, the block-level health
// signals that Garage only offers through node-scoped endpoints:
// resync queue length / errors (GetNodeStatistics?node=*, blockManagerStats,
// Garage >= v2.3.0) and scrub corruptions / last completion
// (GetWorkerVariable?node=*), plus the live state of each node's "Block scrub
// worker" (ListWorkers?node=*) so the UI can tell a running scrub from an idle
// one. scrub-corruptions_detected is a lifetime counter Garage persists in
// metadata_dir/scrub_info and never resets; only an increase is news. It does not call GetClusterStatus: the UI
// already has it and joins on the node ID (and decides which nodes store data).

// nodeStorageHealth is the per-node entry of the response. Every metric is a
// pointer so the UI can tell "0" from "unknown"; Error says why a value is
// missing. Messages are Garage's own text or fixed strings, never transport
// errors (which can carry internal URLs).
type nodeStorageHealth struct {
	ResyncQueueLen     *int64  `json:"resyncQueueLen"`
	ResyncErrors       *int64  `json:"resyncErrors"`
	ScrubCorruptions   *int64  `json:"scrubCorruptions"`
	ScrubLastCompleted *string `json:"scrubLastCompleted"`
	// Scrub is the node's scrub worker, or null when ListWorkers failed or
	// the node did not list one.
	Scrub *scrubWorkerStatus `json:"scrub"`
	Error string             `json:"error,omitempty"`
}

// scrubWorkerStatus is the subset of Garage's WorkerInfoResp for the
// "Block scrub worker". State is Garage's WorkerStateResp passed through
// as-is ("busy" / "idle" / "done" or {"throttled": {"durationSecs": n}}), so
// the UI decodes it like the workers page. Progress is Garage's own
// percentage string (e.g. "42.00%"), set while a scrub runs or is paused.
type scrubWorkerStatus struct {
	State       json.RawMessage `json:"state"`
	Progress    *string         `json:"progress,omitempty"`
	Tranquility *int64          `json:"tranquility,omitempty"`
}

// scrubWorkerName is the name Garage gives the scrub worker (src/block/repair.rs).
const scrubWorkerName = "Block scrub worker"

// storageHealthResponse is the body of GET /api/cluster/storage-health.
// Nodes is keyed by full node ID and holds every node that appeared in any
// fan-out. StatsError / VarsError are set when a whole fan-out failed; the UI
// then shows them for every node.
type storageHealthResponse struct {
	Nodes      map[string]*nodeStorageHealth `json:"nodes"`
	StatsError string                        `json:"statsError,omitempty"`
	VarsError  string                        `json:"varsError,omitempty"`
	// WorkersError is set when the ListWorkers fan-out failed; every
	// node's scrub is then null.
	WorkersError string `json:"workersError,omitempty"`
}

const (
	storageHealthTTL      = 10 * time.Second
	statsUnavailableMsg   = "ノード統計の取得に失敗しました"
	varsUnavailableMsg    = "worker 変数の取得に失敗しました"
	nodeNotAnsweredMsg    = "ノードが応答しませんでした"
	workersUnavailableMsg = "worker 一覧の取得に失敗しました"
)

// storageHealthCache shares one fan-out between dashboard tabs and polls;
// storageHealthMu serialises the fetch so concurrent cache misses do not
// each fan out to every node.
var (
	storageHealthCache = ttlCache[storageHealthResponse]{ttl: storageHealthTTL}
	storageHealthMu    sync.Mutex
)

// garageUserMessage turns a fan-out error into something safe to show: the
// fixed fallback, plus the message Garage put in its JSON error body if any.
func garageUserMessage(err error, fallback string) string {
	var se *garageStatusError
	if errors.As(err, &se) {
		var body struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(se.body, &body) == nil && body.Message != "" {
			return fallback + ": " + body.Message
		}
	}
	return fallback
}

// handleStorageHealth serves GET /api/cluster/storage-health. Failures of
// either fan-out are reported inside the 200 response.
func handleStorageHealth(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp := loadStorageHealth(r.Context(), garageAdmin)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}

func loadStorageHealth(ctx context.Context, garageAdmin *GarageAdminClient) storageHealthResponse {
	storageHealthMu.Lock()
	defer storageHealthMu.Unlock()
	if v, ok := storageHealthCache.get(garageAdmin.baseURL); ok {
		return v
	}

	const (
		statsPath   = "/v2/GetNodeStatistics?node=*"
		varsPath    = "/v2/GetWorkerVariable?node=*"
		workersPath = "/v2/ListWorkers?node=*"
	)
	var (
		wg                            sync.WaitGroup
		stats                         nodeStatisticsMulti
		vars                          garageMultiResponse
		workers                       listWorkersMulti
		statsErr, varsErr, workersErr error
	)
	wg.Add(3)
	go func() {
		defer wg.Done()
		statsErr = garageRequestJSON(ctx, garageAdmin, http.MethodGet, statsPath, nil, &stats)
	}()
	go func() {
		defer wg.Done()
		varsErr = garageRequestJSON(ctx, garageAdmin, http.MethodPost, varsPath, []byte(`{}`), &vars)
	}()
	go func() {
		defer wg.Done()
		workersErr = garageRequestJSON(ctx, garageAdmin, http.MethodPost, workersPath, []byte(`{}`), &workers)
	}()
	wg.Wait()
	if statsErr != nil {
		slog.WarnContext(ctx, "node statistics fan-out failed", "path", statsPath, "error", statsErr)
	}
	if varsErr != nil {
		slog.WarnContext(ctx, "worker variables fan-out failed", "path", varsPath, "error", varsErr)
	}
	if workersErr != nil {
		slog.WarnContext(ctx, "list workers fan-out failed", "path", workersPath, "error", workersErr)
	}

	out := buildStorageHealth(stats, statsErr, vars, varsErr, workers, workersErr)
	// If the client went away the result is made of cancellations; don't cache it.
	if ctx.Err() == nil {
		storageHealthCache.put(garageAdmin.baseURL, out)
	}
	return out
}

// buildStorageHealth merges the three fan-out answers by node ID.
func buildStorageHealth(stats nodeStatisticsMulti, statsErr error, vars garageMultiResponse, varsErr error, workers listWorkersMulti, workersErr error) storageHealthResponse {
	out := storageHealthResponse{Nodes: map[string]*nodeStorageHealth{}}
	errs := map[string][]string{}
	statsSeen, varsSeen := map[string]bool{}, map[string]bool{}
	node := func(id string) *nodeStorageHealth {
		if n, ok := out.Nodes[id]; ok {
			return n
		}
		n := &nodeStorageHealth{}
		out.Nodes[id] = n
		return n
	}

	if statsErr != nil {
		out.StatsError = garageUserMessage(statsErr, statsUnavailableMsg)
	} else {
		// Reuse the repair page's aggregation for the per-node block stats.
		block := aggregateNodeStatistics(stats)
		for _, b := range block.Nodes {
			statsSeen[b.NodeID] = true
			n := node(b.NodeID)
			n.ResyncQueueLen = &b.ResyncQueueLen
			n.ResyncErrors = &b.ResyncErrors
		}
		for id, msg := range block.NodeErrors {
			statsSeen[id] = true
			node(id)
			errs[id] = append(errs[id], "ノード統計: "+msg)
		}
	}

	if varsErr != nil {
		out.VarsError = garageUserMessage(varsErr, varsUnavailableMsg)
	} else {
		for id, raw := range vars.Success {
			varsSeen[id] = true
			n := node(id)
			var m map[string]string
			if err := json.Unmarshal(raw, &m); err != nil {
				errs[id] = append(errs[id], "worker 変数の応答が不正です")
				continue
			}
			if v, ok := m["scrub-corruptions_detected"]; !ok {
				errs[id] = append(errs[id], "scrub-corruptions_detected が報告されていません")
			} else if c, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err != nil {
				errs[id] = append(errs[id], "scrub-corruptions_detected を解釈できません: "+v)
			} else {
				n.ScrubCorruptions = &c
			}
			if v, ok := m["scrub-last-completed"]; ok {
				n.ScrubLastCompleted = &v
			}
		}
		for id, msg := range vars.Error {
			varsSeen[id] = true
			node(id)
			errs[id] = append(errs[id], "worker 変数: "+msg)
		}
	}

	// The scrub worker is supplementary: a node that answered ListWorkers but
	// does not list one simply has scrub = null (the UI falls back to the
	// last completion time), and a node missing from ListWorkers is not an
	// error of its own. A node only ListWorkers reported is still kept.
	if workersErr != nil {
		out.WorkersError = garageUserMessage(workersErr, workersUnavailableMsg)
	} else {
		for id, list := range workers.Success {
			n := node(id)
			for _, raw := range list {
				var w struct {
					Name string `json:"name"`
					scrubWorkerStatus
				}
				if json.Unmarshal(raw, &w) == nil && w.Name == scrubWorkerName {
					n.Scrub = &w.scrubWorkerStatus
					break
				}
			}
		}
		for id, msg := range workers.Error {
			node(id)
			errs[id] = append(errs[id], "worker 一覧: "+msg)
		}
	}

	// A node that answered one fan-out but is missing from the other.
	for id, n := range out.Nodes {
		if statsErr == nil && !statsSeen[id] {
			errs[id] = append(errs[id], "ノード統計: "+nodeNotAnsweredMsg)
		}
		if varsErr == nil && !varsSeen[id] {
			errs[id] = append(errs[id], "worker 変数: "+nodeNotAnsweredMsg)
		}
		n.Error = strings.Join(errs[id], "; ")
	}
	return out
}
