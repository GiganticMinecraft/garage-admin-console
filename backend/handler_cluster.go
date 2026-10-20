package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"time"
)

// proxyGarageGET is a helper that proxies a GET request to the Garage Admin API
// and streams the JSON response back to the client.
func proxyGarageGET(garageAdmin *GarageAdminClient, garagePath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		proxyGarageRequest(w, r, garageAdmin, http.MethodGet, garagePath, nil)
	}
}

// proxyGarageRequest sends one request to the Garage Admin API and streams
// the response back unchanged. A transport failure becomes a 502.
func proxyGarageRequest(w http.ResponseWriter, r *http.Request, garageAdmin *GarageAdminClient, method, garagePath string, body io.Reader) {
	resp, err := garageAdmin.doRequest(r.Context(), method, garagePath, body)
	if err != nil {
		slog.ErrorContext(r.Context(), "garage request failed", "path", garagePath, "error", err)
		http.Error(w, "Bad Gateway", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	forwardResponse(w, r, resp, garagePath)
}

// forwardResponse streams an upstream response (status, content type, body) to the client.
func forwardResponse(w http.ResponseWriter, r *http.Request, resp *http.Response, garagePath string) {
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

// handleClusterHealth proxies GET /api/cluster/health to Garage GET /v2/GetClusterHealth.
func handleClusterHealth(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/v2/GetClusterHealth")
}

// handleClusterStatus proxies GET /api/cluster/status to Garage GET /v2/GetClusterStatus.
func handleClusterStatus(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/v2/GetClusterStatus")
}

// handleClusterLayout proxies GET /api/cluster/layout to Garage GET /v2/GetClusterLayout.
func handleClusterLayout(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/v2/GetClusterLayout")
}

// Layout changes in Garage are a three-step workflow: stage role changes
// (UpdateClusterLayout), optionally preview the resulting assignment
// (PreviewClusterLayoutChanges), then commit them with ApplyClusterLayout,
// whose body is only {"version": current+1} as a safety check. Staged changes
// can be discarded with RevertClusterLayout.

// handleStageLayout proxies POST /api/cluster/layout/stage to Garage POST /v2/UpdateClusterLayout.
// Body: {"roles":[{"id":..., "zone":..., "capacity":..., "tags":[...]} | {"id":..., "remove":true}], "parameters":{...}}
func handleStageLayout(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGaragePOST(garageAdmin, "/v2/UpdateClusterLayout")
}

// handlePreviewLayout proxies POST /api/cluster/layout/preview to Garage POST /v2/PreviewClusterLayoutChanges.
func handlePreviewLayout(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGaragePOST(garageAdmin, "/v2/PreviewClusterLayoutChanges")
}

// handleRevertLayout proxies POST /api/cluster/layout/revert to Garage POST /v2/RevertClusterLayout.
func handleRevertLayout(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGaragePOST(garageAdmin, "/v2/RevertClusterLayout")
}

// handleApplyLayout proxies POST /api/cluster/layout/apply to Garage POST /v2/ApplyClusterLayout.
// The request body ({"version": n}) is forwarded as-is.
func handleApplyLayout(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGaragePOST(garageAdmin, "/v2/ApplyClusterLayout")
}

// handleLayoutHistory proxies GET /api/cluster/layout/history to Garage GET /v2/GetClusterLayoutHistory.
// The response carries currentVersion, minAck, the current/draining/historical
// versions and, while more than one version is live, per-node update trackers
// (ack / sync / syncAck) that the UI turns into a progress tracker.
func handleLayoutHistory(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/v2/GetClusterLayoutHistory")
}

// handleSkipDeadNodes proxies POST /api/cluster/layout/skip-dead-nodes to Garage
// POST /v2/ClusterLayoutSkipDeadNodes. Body: {"version": n, "allowMissingData": bool}.
// It is the escape hatch for a layout update stuck on nodes that are down.
// With allowMissingData Garage also marks every node as synced, which can lose
// data that only existed on the skipped nodes. Garage rejects the call with
// 400 when only one layout version is live; that error is forwarded as-is.
func handleSkipDeadNodes(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGaragePOST(garageAdmin, "/v2/ClusterLayoutSkipDeadNodes")
}

// handleClusterStatistics proxies GET /api/cluster/statistics to Garage GET
// /v2/GetClusterStatistics. Since Garage v2.3.0 the answer is structured:
// dataAvail, metadataAvail, incompleteAvailInfo, bucketCount and, unless the
// cluster has more than 1000 buckets, totalObjectCount / totalObjectBytes,
// plus the freeform text. It is returned as-is.
func handleClusterStatistics(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/v2/GetClusterStatistics")
}

// connectNodesTimeout bounds one ConnectClusterNodes call. Garage tries the
// peers itself and answers only once every attempt has finished, so one
// unreachable peer can take longer than the client's usual 10 s timeout;
// cutting it off would also lose the results of the peers that connected.
var connectNodesTimeout = 60 * time.Second

// maxConnectNodes caps how many peers one connect request may name.
const maxConnectNodes = 10

// maxConnectBodyBytes bounds the connect request body; ten 64-hex IDs with
// addresses fit comfortably.
const maxConnectBodyBytes = 16 << 10

// connectPeerPattern is the `<node_id>@<addr:port>` form printed by
// `garage node id`: a full 64-hex node ID, then a host (name, IPv4 or
// bracketed IPv6) and a port.
var connectPeerPattern = regexp.MustCompile(`^[0-9a-f]{64}@[^\s@]+:[0-9]+$`)

// connectNodesRequest is the body of POST /api/cluster/connect.
type connectNodesRequest struct {
	Nodes []string `json:"nodes"`
}

// connectNodeResult is one entry of Garage's ConnectClusterNodesResponse,
// at the same position as the peer it answers for.
type connectNodeResult struct {
	Success bool    `json:"success"`
	Error   *string `json:"error"`
}

// validateConnectNodes checks the peer list and returns a message for the
// first problem found, or "" when the list is acceptable.
func validateConnectNodes(nodes []string) string {
	if len(nodes) == 0 {
		return "nodes must contain at least one entry"
	}
	if len(nodes) > maxConnectNodes {
		return fmt.Sprintf("nodes must contain at most %d entries", maxConnectNodes)
	}
	for i, n := range nodes {
		if !connectPeerPattern.MatchString(n) {
			return fmt.Sprintf("nodes[%d] must be <64-hex node id>@<host>:<port>", i)
		}
	}
	return ""
}

// handleConnectNodes handles POST /api/cluster/connect by calling Garage
// POST /v2/ConnectClusterNodes. Body: {"nodes": ["<id>@<addr:port>", ...]}.
// Garage answers 200 even when some connections fail, with one
// {success, error} entry per peer in request order; that array is returned
// in the same order so the UI can show each line's result. An answer whose
// length differs from the request cannot be matched to the peers and
// becomes a 502. A non-200 answer from Garage is forwarded as-is. The call is
// bounded by connectNodesTimeout instead of the client's own timeout.
func handleConnectNodes(garageAdmin *GarageAdminClient) http.HandlerFunc {
	client := garageAdmin.withoutClientTimeout()
	return func(w http.ResponseWriter, r *http.Request) {
		data, ok := readRequestBody(w, r, maxConnectBodyBytes)
		if !ok {
			return
		}
		var req connectNodesRequest
		if err := json.Unmarshal(data, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if msg := validateConnectNodes(req.Nodes); msg != "" {
			writeJSONError(w, http.StatusBadRequest, msg)
			return
		}
		body, err := json.Marshal(req.Nodes)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "cannot encode request")
			return
		}

		const garagePath = "/v2/ConnectClusterNodes"
		ctx, cancel := context.WithTimeout(r.Context(), connectNodesTimeout)
		defer cancel()
		resp, err := client.doRequest(ctx, http.MethodPost, garagePath, bytes.NewReader(body))
		if err != nil {
			slog.ErrorContext(r.Context(), "garage request failed", "path", garagePath, "error", err)
			http.Error(w, "Bad Gateway", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			forwardResponse(w, r, resp, garagePath)
			return
		}

		var results []connectNodeResult
		if err := json.NewDecoder(resp.Body).Decode(&results); err != nil {
			slog.ErrorContext(r.Context(), "failed to decode ConnectClusterNodes response", "error", err)
			writeJSONError(w, http.StatusBadGateway, "cannot decode Garage response")
			return
		}
		if len(results) != len(req.Nodes) {
			slog.ErrorContext(r.Context(), "ConnectClusterNodes answered a different number of peers", "requested", len(req.Nodes), "answered", len(results))
			writeJSONError(w, http.StatusBadGateway, "Garage response does not match the requested nodes")
			return
		}
		for i, res := range results {
			if !res.Success {
				msg := ""
				if res.Error != nil {
					msg = *res.Error
				}
				slog.WarnContext(r.Context(), "ConnectClusterNodes failed for peer", "index", i, "peer", req.Nodes[i], "error", msg)
			}
		}
		writeJSON(w, results)
	}
}
