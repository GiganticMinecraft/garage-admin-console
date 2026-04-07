package main

import "net/http"

// handleLaunchRepair proxies POST /api/repair to Garage POST /v2/LaunchRepairOperation?node=*.
// The request body { "repairType": ... } is forwarded as-is.
// The MultiResponse is forwarded as-is so the frontend can show per-node success/error.
func handleLaunchRepair(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGaragePOST(garageAdmin, "/v2/LaunchRepairOperation?node=*")
}
