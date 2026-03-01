package main

import "net/http"

// handleListWorkers proxies GET /api/workers to Garage GET /v2/worker?list.
func handleListWorkers(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/v2/worker?list")
}
