package main

import (
	"net/http"
	"net/url"
	"regexp"

	"github.com/go-chi/chi/v5"
)

// Admin API token management under /api/admin-tokens, proxied to Garage's
// v2 admin token endpoints. Garage answers with GetAdminTokenInfoResponse
// objects ({id, created, name, expiration, expired, scope}); tokens defined in
// the daemon configuration (admin_token / metrics_token) are listed with
// id == null and cannot be fetched, updated or deleted by ID. Responses are
// passed through unchanged.

// adminTokenIDPattern matches a Garage admin token ID: the hex prefix of the
// bearer token (24 hex characters today). The bound keeps junk out of the
// query string Garage receives.
var adminTokenIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{1,64}$`)

// maxAdminTokenRequestBody bounds the small JSON bodies of create / update.
const maxAdminTokenRequestBody = 64 << 10

// adminTokenIDParam validates the {id} URL parameter and writes a 400 on failure.
func adminTokenIDParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "id")
	if !adminTokenIDPattern.MatchString(id) {
		writeJSONError(w, http.StatusBadRequest, "invalid admin token id: must be hex")
		return "", false
	}
	return id, true
}

// handleListAdminTokens proxies GET /api/admin-tokens to Garage GET /v2/ListAdminTokens.
func handleListAdminTokens(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/v2/ListAdminTokens")
}

// handleGetCurrentAdminToken proxies GET /api/admin-tokens/current to Garage
// GET /v2/GetCurrentAdminTokenInfo, i.e. the token this console itself uses
// (Garage identifies it from the Authorization header). Garage allows this
// endpoint for every valid token regardless of its scope.
func handleGetCurrentAdminToken(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return proxyGarageGET(garageAdmin, "/v2/GetCurrentAdminTokenInfo")
}

// handleGetAdminToken proxies GET /api/admin-tokens/{id} to Garage GET /v2/GetAdminTokenInfo?id={id}.
func handleGetAdminToken(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := adminTokenIDParam(w, r)
		if !ok {
			return
		}
		proxyGarageRequest(w, r, garageAdmin, http.MethodGet, "/v2/GetAdminTokenInfo?id="+url.QueryEscape(id), nil)
	}
}

// handleCreateAdminToken proxies POST /api/admin-tokens to Garage POST
// /v2/CreateAdminToken. The body ({name?, expiration?, neverExpires?, scope?})
// is forwarded as-is. The response carries the secret bearer token, which
// Garage returns only this once: it is streamed straight through (never
// logged) and marked no-store so no browser or proxy cache keeps a copy.
func handleCreateAdminToken(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		body := http.MaxBytesReader(w, r.Body, maxAdminTokenRequestBody)
		proxyGarageRequest(w, r, garageAdmin, http.MethodPost, "/v2/CreateAdminToken", body)
	}
}

// handleUpdateAdminToken proxies PUT /api/admin-tokens/{id} to Garage POST
// /v2/UpdateAdminToken?id={id} with the body ({name?, expiration?,
// neverExpires?, scope?}) forwarded as-is.
func handleUpdateAdminToken(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := adminTokenIDParam(w, r)
		if !ok {
			return
		}
		body := http.MaxBytesReader(w, r.Body, maxAdminTokenRequestBody)
		proxyGarageRequest(w, r, garageAdmin, http.MethodPost, "/v2/UpdateAdminToken?id="+url.QueryEscape(id), body)
	}
}

// handleDeleteAdminToken proxies DELETE /api/admin-tokens/{id} to Garage POST /v2/DeleteAdminToken?id={id}.
func handleDeleteAdminToken(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := adminTokenIDParam(w, r)
		if !ok {
			return
		}
		proxyGarageRequest(w, r, garageAdmin, http.MethodPost, "/v2/DeleteAdminToken?id="+url.QueryEscape(id), nil)
	}
}
