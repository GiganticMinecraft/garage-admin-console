package main

import (
	"io"
	"log/slog"
	"net/http"
)

// proxyGarageGET is a helper that proxies a GET request to the Garage Admin API
// and streams the JSON response back to the client.
func proxyGarageGET(garageAdmin *GarageAdminClient, garagePath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp, err := garageAdmin.doRequest(r.Context(), http.MethodGet, garagePath, nil)
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
