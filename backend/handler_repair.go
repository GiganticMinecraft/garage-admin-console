package main

import (
	"bytes"
	"net/http"
)

// maxRepairRequestBody bounds the LaunchRepairOperation body ({"repairType": ...}).
const maxRepairRequestBody = 4 << 10

// handleLaunchRepair proxies POST /api/repair to Garage POST /v2/LaunchRepairOperation?node=*.
// The request body { "repairType": ... } is forwarded as-is after
// guardDestructiveRepair has checked the cluster state for the repairs that
// delete metadata (see repair_guard.go).
// The MultiResponse is forwarded as-is so the frontend can show per-node success/error.
func handleLaunchRepair(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, ok := readRequestBody(w, r, maxRepairRequestBody)
		if !ok {
			return
		}
		if !guardDestructiveRepair(r.Context(), w, garageAdmin, body) {
			return
		}
		proxyGarageRequest(w, r, garageAdmin, http.MethodPost, "/v2/LaunchRepairOperation?node=*", bytes.NewReader(body))
	}
}
