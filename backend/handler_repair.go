package main

import (
	"bytes"
	"io"
	"net/http"
)

// maxRepairRequestBody bounds the LaunchRepairOperation body ({"repairType": ...}).
const maxRepairRequestBody = 4 << 10

// handleLaunchRepair proxies POST /api/repair to Garage POST /v2/LaunchRepairOperation?node=*.
// The request body { "repairType": ... } is forwarded as-is after
// guardDestructiveRepair has checked the cluster health for the repairs that
// delete metadata (see repair_guard.go).
// The MultiResponse is forwarded as-is so the frontend can show per-node success/error.
func handleLaunchRepair(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRepairRequestBody))
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "request body too large or unreadable")
			return
		}
		if !guardDestructiveRepair(r.Context(), w, garageAdmin, body) {
			return
		}
		proxyGarageRequest(w, r, garageAdmin, http.MethodPost, "/v2/LaunchRepairOperation?node=*", bytes.NewReader(body))
	}
}
