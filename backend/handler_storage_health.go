package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// storageNodeHealth is one entry of GET /api/cluster/storage-health.
//
// Every metric is a pointer so the UI can tell "0" from "unknown": a value is
// null when the node did not answer the corresponding fan-out request (Error
// then says why) or runs a Garage that does not report it.
type storageNodeHealth struct {
	ID                 string  `json:"id"`
	Hostname           *string `json:"hostname"`
	IsUp               bool    `json:"isUp"`
	ResyncQueueLen     *int64  `json:"resyncQueueLen"`
	ResyncErrors       *int64  `json:"resyncErrors"`
	ScrubCorruptions   *int64  `json:"scrubCorruptions"`
	ScrubLastCompleted *string `json:"scrubLastCompleted"`
	Error              string  `json:"error,omitempty"`
}

// clusterStatusNodes is the subset of Garage's GetClusterStatus we need to
// list the storage nodes (nodes whose current role has a capacity).
type clusterStatusNodes struct {
	Nodes []struct {
		ID       string  `json:"id"`
		Hostname *string `json:"hostname"`
		IsUp     bool    `json:"isUp"`
		Role     *struct {
			Capacity *int64 `json:"capacity"`
		} `json:"role"`
	} `json:"nodes"`
}

// fetchGarageJSON calls a Garage admin endpoint and decodes a 200 JSON answer
// into dst. Non-200 answers become an error carrying Garage's message.
func fetchGarageJSON(ctx context.Context, garageAdmin *GarageAdminClient, method, garagePath string, body io.Reader, dst any) error {
	resp, err := garageAdmin.doRequest(ctx, method, garagePath, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		var gErr struct {
			Message string `json:"message"`
		}
		msg := strings.TrimSpace(string(data))
		if json.Unmarshal(data, &gErr) == nil && gErr.Message != "" {
			msg = gErr.Message
		}
		return fmt.Errorf("garage %s: %d %s", garagePath, resp.StatusCode, msg)
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}

// handleStorageHealth serves GET /api/cluster/storage-health: per storage node
// resync queue length / errors (GetNodeStatistics?node=*, blockManagerStats,
// Garage >= v2.3.0) and scrub corruptions / last completion
// (GetWorkerVariable?node=*). Nodes that fail either fan-out keep whatever was
// fetched and carry an error message; the response is still 200. Only a
// failing GetClusterStatus (needed to know the storage nodes) fails the call.
func handleStorageHealth(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		const statusPath = "/v2/GetClusterStatus"
		resp, err := garageAdmin.doRequest(ctx, http.MethodGet, statusPath, nil)
		if err != nil {
			slog.ErrorContext(ctx, "garage request failed", "path", statusPath, "error", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}
		if resp.StatusCode != http.StatusOK {
			defer resp.Body.Close()
			forwardResponse(w, r, resp, statusPath)
			return
		}
		var status clusterStatusNodes
		err = json.NewDecoder(resp.Body).Decode(&status)
		resp.Body.Close()
		if err != nil {
			slog.ErrorContext(ctx, "failed to decode GetClusterStatus response", "error", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}

		// The two fan-outs are independent and each waits for the slowest
		// node, so run them concurrently.
		var (
			wg                 sync.WaitGroup
			stats              nodeStatisticsMulti
			vars               garageMultiResponse
			statsErr, varsErr  error
			statsPath, varPath = "/v2/GetNodeStatistics?node=*", "/v2/GetWorkerVariable?node=*"
		)
		wg.Add(2)
		go func() {
			defer wg.Done()
			statsErr = fetchGarageJSON(ctx, garageAdmin, http.MethodGet, statsPath, nil, &stats)
		}()
		go func() {
			defer wg.Done()
			varsErr = fetchGarageJSON(ctx, garageAdmin, http.MethodPost, varPath, strings.NewReader(`{}`), &vars)
		}()
		wg.Wait()
		if statsErr != nil {
			slog.WarnContext(ctx, "node statistics unavailable", "path", statsPath, "error", statsErr)
		}
		if varsErr != nil {
			slog.WarnContext(ctx, "worker variables unavailable", "path", varPath, "error", varsErr)
		}

		writeJSON(w, buildStorageHealth(status, stats, statsErr, vars, varsErr))
	}
}

// buildStorageHealth merges the cluster status and both fan-out answers into
// one entry per storage node, sorted by hostname then ID.
func buildStorageHealth(status clusterStatusNodes, stats nodeStatisticsMulti, statsErr error, vars garageMultiResponse, varsErr error) []storageNodeHealth {
	// Reuse the repair page's aggregation for the per-node block stats.
	block := aggregateNodeStatistics(stats)
	blockByID := make(map[string]nodeBlockStats, len(block.Nodes))
	for _, n := range block.Nodes {
		blockByID[n.NodeID] = n
	}

	out := []storageNodeHealth{}
	for _, n := range status.Nodes {
		if n.Role == nil || n.Role.Capacity == nil {
			continue // gateway or role-less node: no block storage
		}
		h := storageNodeHealth{ID: n.ID, Hostname: n.Hostname, IsUp: n.IsUp}
		var errs []string

		switch b, ok := blockByID[n.ID]; {
		case statsErr != nil:
			errs = append(errs, "node statistics unavailable: "+statsErr.Error())
		case ok:
			h.ResyncQueueLen = &b.ResyncQueueLen
			h.ResyncErrors = &b.ResyncErrors
		case block.NodeErrors[n.ID] != "":
			errs = append(errs, "node statistics: "+block.NodeErrors[n.ID])
		default:
			errs = append(errs, "node statistics: node did not answer")
		}

		switch raw, ok := vars.Success[n.ID]; {
		case varsErr != nil:
			errs = append(errs, "worker variables unavailable: "+varsErr.Error())
		case ok:
			var m map[string]string
			if err := json.Unmarshal(raw, &m); err != nil {
				errs = append(errs, "worker variables: invalid response")
				break
			}
			if v, ok := m["scrub-corruptions_detected"]; ok {
				if c, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
					h.ScrubCorruptions = &c
				}
			}
			if v, ok := m["scrub-last-completed"]; ok {
				h.ScrubLastCompleted = &v
			}
		case vars.Error[n.ID] != "":
			errs = append(errs, "worker variables: "+vars.Error[n.ID])
		default:
			errs = append(errs, "worker variables: node did not answer")
		}

		h.Error = strings.Join(errs, "; ")
		out = append(out, h)
	}
	sort.SliceStable(out, func(i, j int) bool {
		hi, hj := derefString(out[i].Hostname), derefString(out[j].Hostname)
		if hi != hj {
			return hi < hj
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
