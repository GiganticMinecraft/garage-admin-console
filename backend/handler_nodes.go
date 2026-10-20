package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// Per-node endpoints under /api/nodes/{id}. Garage's node-scoped admin
// endpoints all take a `node` query parameter (a full or prefix hex node ID,
// "self" for the node behind the admin endpoint, or "*" for every node) and
// answer with a MultiResponse { "success": {nodeId: ...}, "error": {nodeId: msg} }.
//
// Read endpoints (info, stats, worker variables, workers) unwrap that
// envelope for the single requested node so the UI gets the plain payload, and
// turn a per-node error into a 502 carrying Garage's message. Mutating
// endpoints (repair, snapshot, set worker variable) return the MultiResponse
// as-is, like /api/repair, because they can also target every node at once.

// maxNodeRequestBody bounds the small JSON bodies of the mutating endpoints.
const maxNodeRequestBody = 64 << 10

// snapshotTimeout bounds CreateMetadataSnapshot, which Garage answers only
// after the snapshot is written; a large LMDB can take far longer than the
// admin client's default 10s timeout.
const snapshotTimeout = 10 * time.Minute

// nodeIDParam validates the {id} URL parameter as what Garage's `node`
// parameter accepts for a single node: "self" or a (prefix of a) hex node ID.
// "*" is deliberately not accepted in the path; fan-out is opt-in via
// allNodes in the request body.
func nodeIDParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	return hexIDParam(w, r, "node", "self")
}

// hexIDPattern matches a (prefix of a) hex ID as used by Garage for node IDs
// and admin token IDs. The bound keeps junk out of the query strings sent to
// Garage.
var hexIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{1,64}$`)

// hexIDParam validates the {id} URL parameter as 1-64 hex characters (or one
// of the literal values in also) and writes a JSON 400 on failure.
func hexIDParam(w http.ResponseWriter, r *http.Request, what string, also ...string) (string, bool) {
	id := chi.URLParam(r, "id")
	if hexIDPattern.MatchString(id) || slices.Contains(also, id) {
		return id, true
	}
	msg := "invalid " + what + " id: must be hex"
	for _, a := range also {
		msg += ` or "` + a + `"`
	}
	writeJSONError(w, http.StatusBadRequest, msg)
	return "", false
}

// readRequestBody reads a request body bounded to limit bytes. It writes a
// JSON 413 when the body is too large (400 when unreadable) and returns false.
func readRequestBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, bool) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("request body too large (limit %d bytes)", limit))
		} else {
			writeJSONError(w, http.StatusBadRequest, "request body unreadable")
		}
		return nil, false
	}
	return data, true
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// garageMultiResponse is Garage's envelope for node-scoped endpoints.
type garageMultiResponse struct {
	Success map[string]json.RawMessage `json:"success"`
	Error   map[string]string          `json:"error"`
}

// errNodeNotAnswered is returned by singleNodeResult when the envelope has no
// usable entry for the requested node.
var errNodeNotAnswered = errors.New("node did not answer")

// singleNodeResult extracts the one success entry for a single-node request.
// A per-node error, an empty envelope, or an ambiguous ID prefix matching
// several nodes are reported as errors with a human-readable message.
func singleNodeResult(multi garageMultiResponse) (string, json.RawMessage, error) {
	if len(multi.Error) > 0 {
		ids := make([]string, 0, len(multi.Error))
		for id := range multi.Error {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		msgs := make([]string, 0, len(ids))
		for _, id := range ids {
			msgs = append(msgs, fmt.Sprintf("%s: %s", shortNodeID(id), multi.Error[id]))
		}
		return "", nil, fmt.Errorf("%w: %s", errNodeNotAnswered, strings.Join(msgs, "; "))
	}
	switch len(multi.Success) {
	case 0:
		return "", nil, fmt.Errorf("%w: empty response", errNodeNotAnswered)
	case 1:
		for id, raw := range multi.Success {
			return id, raw, nil
		}
	}
	return "", nil, fmt.Errorf("%w: node id prefix matches %d nodes", errNodeNotAnswered, len(multi.Success))
}

func shortNodeID(id string) string {
	if len(id) > 16 {
		return id[:16]
	}
	return id
}

// fetchSingleNode calls a node-scoped Garage endpoint for one node and returns
// the unwrapped payload. When it returns ok=false the response has already
// been written: Garage's own error body for non-200 answers (so the UI can
// show e.g. "No nodes matching ..."), or a 502 with the per-node error.
func fetchSingleNode(w http.ResponseWriter, r *http.Request, garageAdmin *GarageAdminClient, method, garagePath string, body []byte) (string, json.RawMessage, bool) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	resp, err := garageAdmin.doRequest(r.Context(), method, garagePath, reader)
	if err != nil {
		slog.ErrorContext(r.Context(), "garage request failed", "path", garagePath, "error", err)
		http.Error(w, "Bad Gateway", http.StatusBadGateway)
		return "", nil, false
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		forwardResponse(w, r, resp, garagePath)
		return "", nil, false
	}

	var multi garageMultiResponse
	if err := json.NewDecoder(resp.Body).Decode(&multi); err != nil {
		slog.ErrorContext(r.Context(), "failed to decode garage multi response", "path", garagePath, "error", err)
		http.Error(w, "Bad Gateway", http.StatusBadGateway)
		return "", nil, false
	}
	nodeID, raw, err := singleNodeResult(multi)
	if err != nil {
		slog.WarnContext(r.Context(), "node-scoped request failed", "path", garagePath, "error", err)
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return "", nil, false
	}
	return nodeID, raw, true
}

func writeRawJSON(w http.ResponseWriter, raw []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Write(raw)
}

// nodeTarget returns the Garage `node` parameter: the path ID, or "*" when
// the caller explicitly asked to apply the operation to every node.
func nodeTarget(id string, allNodes bool) string {
	if allNodes {
		return "*"
	}
	return id
}

// decodeNodeBody decodes a bounded JSON request body. An empty body is
// accepted and leaves dst untouched. Writes a 400 and returns false on error.
func decodeNodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxNodeRequestBody))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "request body too large or unreadable")
		return false
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return true
	}
	if err := json.Unmarshal(data, dst); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return false
	}
	return true
}

// handleGetNode proxies GET /api/nodes/{id} to Garage GET /v2/GetNodeInfo?node={id}
// and returns the node's info object (nodeId, hostname, garageVersion,
// garageFeatures, rustVersion, dbEngine, addr, isUp, role, draining,
// dataPartition, metadataPartition; the latter fields need Garage >= v2.4.0).
func handleGetNode(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := nodeIDParam(w, r)
		if !ok {
			return
		}
		_, raw, ok := fetchSingleNode(w, r, garageAdmin, http.MethodGet, "/v2/GetNodeInfo?node="+url.QueryEscape(id), nil)
		if !ok {
			return
		}
		writeRawJSON(w, raw)
	}
}

// handleGetNodeStats proxies GET /api/nodes/{id}/stats to Garage GET
// /v2/GetNodeStatistics?node={id} and returns the full statistics object:
// freeform (always), tableStats and blockManagerStats (Garage >= v2.3.0).
func handleGetNodeStats(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := nodeIDParam(w, r)
		if !ok {
			return
		}
		_, raw, ok := fetchSingleNode(w, r, garageAdmin, http.MethodGet, "/v2/GetNodeStatistics?node="+url.QueryEscape(id), nil)
		if !ok {
			return
		}
		writeRawJSON(w, raw)
	}
}

// handleGetNodeWorkerVariables proxies GET /api/nodes/{id}/worker-variables to
// Garage POST /v2/GetWorkerVariable?node={id} without a variable name, which
// returns every background variable of that node as a {name: value} map of
// strings (resync-tranquility, resync-worker-count, scrub-tranquility,
// scrub-last-completed, scrub-next-run, scrub-corruptions_detected, ...).
func handleGetNodeWorkerVariables(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := nodeIDParam(w, r)
		if !ok {
			return
		}
		_, raw, ok := fetchSingleNode(w, r, garageAdmin, http.MethodPost, "/v2/GetWorkerVariable?node="+url.QueryEscape(id), []byte(`{}`))
		if !ok {
			return
		}
		writeRawJSON(w, raw)
	}
}

// settableWorkerVariables are the writable Garage background variables the
// console exposes. Everything else (read-only scrub/lifecycle state, or
// variables added by future Garage versions) is rejected before reaching Garage.
var settableWorkerVariables = map[string]bool{
	"resync-tranquility":  true,
	"resync-worker-count": true,
	"scrub-tranquility":   true,
}

// setWorkerVariableRequest is the body of POST /api/nodes/{id}/worker-variables.
type setWorkerVariableRequest struct {
	Variable string `json:"variable"`
	Value    string `json:"value"`
	AllNodes bool   `json:"allNodes"`
}

// handleSetNodeWorkerVariable proxies POST /api/nodes/{id}/worker-variables to
// Garage POST /v2/SetWorkerVariable?node={id|*}. Body: {variable, value, allNodes?}.
// Only settableWorkerVariables are accepted; Garage validates the value.
// Its MultiResponse is returned as-is.
func handleSetNodeWorkerVariable(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := nodeIDParam(w, r)
		if !ok {
			return
		}
		var req setWorkerVariableRequest
		if !decodeNodeBody(w, r, &req) {
			return
		}
		variable := strings.TrimSpace(req.Variable)
		value := strings.TrimSpace(req.Value)
		if variable == "" || value == "" {
			writeJSONError(w, http.StatusBadRequest, "variable and value are required")
			return
		}
		if !settableWorkerVariables[variable] {
			writeJSONError(w, http.StatusBadRequest, "unsupported worker variable: "+variable)
			return
		}
		body, _ := json.Marshal(map[string]string{"variable": variable, "value": value})
		proxyGarageRequest(w, r, garageAdmin, http.MethodPost, "/v2/SetWorkerVariable?node="+url.QueryEscape(nodeTarget(id, req.AllNodes)), bytes.NewReader(body))
	}
}

// handleLaunchNodeRepair proxies POST /api/nodes/{id}/repair to Garage POST
// /v2/LaunchRepairOperation?node={id}. The body has the same shape as
// /api/repair ({"repairType": ...}) and is forwarded as-is; Garage validates it.
func handleLaunchNodeRepair(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := nodeIDParam(w, r)
		if !ok {
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxNodeRequestBody))
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "request body too large or unreadable")
			return
		}
		// A per-node destructive repair still looks parents up on the other
		// nodes, so a disconnected peer is just as dangerous (see repair_guard.go).
		if !guardDestructiveRepair(r.Context(), w, garageAdmin, body) {
			return
		}
		proxyGarageRequest(w, r, garageAdmin, http.MethodPost, "/v2/LaunchRepairOperation?node="+url.QueryEscape(id), bytes.NewReader(body))
	}
}

// handleCreateNodeSnapshot proxies POST /api/nodes/{id}/snapshot to Garage POST
// /v2/CreateMetadataSnapshot?node={id|*}. Body (optional): {"allNodes": true}
// snapshots every node. Garage answers once the snapshot is written, so this
// uses a longer timeout than the default admin client.
func handleCreateNodeSnapshot(garageAdmin *GarageAdminClient) http.HandlerFunc {
	slow := garageAdmin.withTimeout(snapshotTimeout)
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := nodeIDParam(w, r)
		if !ok {
			return
		}
		var req struct {
			AllNodes bool `json:"allNodes"`
		}
		if !decodeNodeBody(w, r, &req) {
			return
		}
		proxyGarageRequest(w, r, slow, http.MethodPost, "/v2/CreateMetadataSnapshot?node="+url.QueryEscape(nodeTarget(id, req.AllNodes)), nil)
	}
}

// handleListNodeWorkers proxies GET /api/nodes/{id}/workers to Garage POST
// /v2/ListWorkers?node={id} and returns the same shape as /api/workers
// ({workers: [...with nodeId], errors: {nodeId: msg}}) restricted to that node.
func handleListNodeWorkers(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := nodeIDParam(w, r)
		if !ok {
			return
		}
		serveWorkers(w, r, garageAdmin, "/v2/ListWorkers?node="+url.QueryEscape(id))
	}
}

// withTimeout returns a copy of the client whose HTTP requests use timeout d.
func (c *GarageAdminClient) withTimeout(d time.Duration) *GarageAdminClient {
	hc := *c.httpClient
	hc.Timeout = d
	return &GarageAdminClient{baseURL: c.baseURL, token: c.token, httpClient: &hc}
}
