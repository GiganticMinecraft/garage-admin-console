package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

const testNodeID = "fb5c134bbb2fa22f734f2b3acfa076996f4a915c7d3c22b20f77146c69ef070b"

// upstreamCall records one request received by the fake Garage.
type upstreamCall struct {
	method, path, node, body string
}

// newFakeNodeGarage serves the node-scoped endpoints with canned MultiResponses
// keyed by testNodeID and records every call.
func newFakeNodeGarage(t *testing.T) (*httptest.Server, func() []upstreamCall) {
	t.Helper()
	var mu sync.Mutex
	var calls []upstreamCall
	mux := http.NewServeMux()
	handle := func(path, payload string) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			body, _ := readAll(r)
			mu.Lock()
			calls = append(calls, upstreamCall{r.Method, r.URL.Path, r.URL.Query().Get("node"), body})
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"success":{"` + testNodeID + `":` + payload + `},"error":{}}`))
		})
	}
	handle("/v2/GetNodeInfo", `{"nodeId":"`+testNodeID+`","hostname":"garage-test","garageVersion":"v2.4.1","dbEngine":"lmdb"}`)
	handle("/v2/GetNodeStatistics", `{"freeform":"Table stats: ...","tableStats":[{"tableName":"object","items":3,"merkleItems":4,"merkleQueueLen":0,"insertQueueLen":0,"gcQueueLen":0}],"blockManagerStats":{"rcEntries":1,"resyncQueueLen":2,"resyncErrors":3}}`)
	handle("/v2/GetWorkerVariable", `{"resync-tranquility":"2","scrub-last-completed":"never"}`)
	handle("/v2/ListWorkers", `[{"id":2,"name":"b","state":"idle"},{"id":1,"name":"a","state":"busy"}]`)
	handle("/v2/SetWorkerVariable", `{"variable":"resync-tranquility","value":"5"}`)
	handle("/v2/LaunchRepairOperation", `null`)
	handle("/v2/CreateMetadataSnapshot", `null`)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, func() []upstreamCall {
		mu.Lock()
		defer mu.Unlock()
		return append([]upstreamCall(nil), calls...)
	}
}

// nodeTestClient sends authenticated, CSRF-valid requests through the full router.
type nodeTestClient struct {
	do func(method, path, body string) *httptest.ResponseRecorder
}

func newNodeTestClient(t *testing.T, garageURL string) *nodeTestClient {
	handler, store := setupTestRouter(t, garageURL)
	return &nodeTestClient{do: func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := authenticatedRequest(t, store, method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}}
}

func TestNodeReadRoutesUnwrapMultiResponse(t *testing.T) {
	garage, calls := newFakeNodeGarage(t)
	c := newNodeTestClient(t, garage.URL)

	for _, tc := range []struct {
		path, wantUpstream, wantMethod, wantContains string
	}{
		{"/api/nodes/self", "/v2/GetNodeInfo", http.MethodGet, `"hostname":"garage-test"`},
		{"/api/nodes/" + testNodeID + "/stats", "/v2/GetNodeStatistics", http.MethodGet, `"tableStats":[{"tableName":"object"`},
		{"/api/nodes/fb5c/worker-variables", "/v2/GetWorkerVariable", http.MethodPost, `"resync-tranquility":"2"`},
	} {
		rec := c.do(http.MethodGet, tc.path, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d body = %s", tc.path, rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), `"success"`) {
			t.Errorf("%s: envelope not unwrapped: %s", tc.path, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), tc.wantContains) {
			t.Errorf("%s: body = %s, want it to contain %s", tc.path, rec.Body.String(), tc.wantContains)
		}
		got := calls()
		last := got[len(got)-1]
		wantNode := strings.Split(strings.TrimPrefix(tc.path, "/api/nodes/"), "/")[0]
		if last.path != tc.wantUpstream || last.method != tc.wantMethod || last.node != wantNode {
			t.Errorf("%s: upstream = %+v, want %s %s node=%s", tc.path, last, tc.wantMethod, tc.wantUpstream, wantNode)
		}
	}
}

func TestNodeWorkersRoute(t *testing.T) {
	garage, calls := newFakeNodeGarage(t)
	c := newNodeTestClient(t, garage.URL)

	rec := c.do(http.MethodGet, "/api/nodes/self/workers", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Workers []map[string]any  `json:"workers"`
		Errors  map[string]string `json:"errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	// "self" is resolved to the real node ID, and workers are sorted by ID.
	if len(got.Workers) != 2 || got.Workers[0]["name"] != "a" || got.Workers[0]["nodeId"] != testNodeID {
		t.Errorf("workers = %v", got.Workers)
	}
	if last := calls()[0]; last.method != http.MethodPost || last.node != "self" || last.body != "{}" {
		t.Errorf("upstream = %+v", last)
	}
}

func TestNodeRoutesRejectInvalidID(t *testing.T) {
	garage, calls := newFakeNodeGarage(t)
	c := newNodeTestClient(t, garage.URL)
	for _, path := range []string{
		"/api/nodes/zz",
		"/api/nodes/%2A/stats",
		"/api/nodes/abc&node=x/workers",
		"/api/nodes/" + strings.Repeat("a", 65),
	} {
		if rec := c.do(http.MethodGet, path, ""); rec.Code != http.StatusBadRequest && rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 400/404", path, rec.Code)
		}
	}
	if rec := c.do(http.MethodPost, "/api/nodes/nothex/snapshot", "{}"); rec.Code != http.StatusBadRequest {
		t.Errorf("snapshot with bad id: status = %d", rec.Code)
	}
	if n := len(calls()); n != 0 {
		t.Errorf("invalid ids must not reach Garage, got %d calls", n)
	}
}

func TestNodeReadRouteErrors(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/GetNodeInfo", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"code":"InvalidRequest","message":"Bad request: No nodes matching abcd"}`))
	})
	mux.HandleFunc("/v2/GetNodeStatistics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success":{},"error":{"` + testNodeID + `":"Not connected"}}`))
	})
	garage := httptest.NewServer(mux)
	defer garage.Close()
	c := newNodeTestClient(t, garage.URL)

	rec := c.do(http.MethodGet, "/api/nodes/abcd", "")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "No nodes matching") {
		t.Errorf("upstream 400 not forwarded: %d %s", rec.Code, rec.Body.String())
	}
	rec = c.do(http.MethodGet, "/api/nodes/abcd/stats", "")
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "Not connected") {
		t.Errorf("per-node error: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSingleNodeResultAmbiguous(t *testing.T) {
	_, _, err := singleNodeResult(garageMultiResponse{Success: map[string]json.RawMessage{"a": nil, "b": nil}})
	if err == nil || !strings.Contains(err.Error(), "matches 2 nodes") {
		t.Errorf("err = %v", err)
	}
	if _, _, err := singleNodeResult(garageMultiResponse{}); err == nil {
		t.Error("empty envelope must be an error")
	}
}

func TestNodeMutatingRoutes(t *testing.T) {
	garage, calls := newFakeNodeGarage(t)
	c := newNodeTestClient(t, garage.URL)

	for _, tc := range []struct {
		path, body string
		want       upstreamCall
	}{
		{"/api/nodes/abcd/worker-variables", `{"variable":"resync-tranquility","value":" 5 "}`,
			upstreamCall{http.MethodPost, "/v2/SetWorkerVariable", "abcd", `{"value":"5","variable":"resync-tranquility"}`}},
		{"/api/nodes/abcd/worker-variables", `{"variable":"scrub-tranquility","value":"3","allNodes":true}`,
			upstreamCall{http.MethodPost, "/v2/SetWorkerVariable", "*", `{"value":"3","variable":"scrub-tranquility"}`}},
		{"/api/nodes/abcd/repair", `{"repairType":{"scrub":"start"}}`,
			upstreamCall{http.MethodPost, "/v2/LaunchRepairOperation", "abcd", `{"repairType":{"scrub":"start"}}`}},
		{"/api/nodes/self/snapshot", ``,
			upstreamCall{http.MethodPost, "/v2/CreateMetadataSnapshot", "self", ""}},
		{"/api/nodes/abcd/snapshot", `{"allNodes":true}`,
			upstreamCall{http.MethodPost, "/v2/CreateMetadataSnapshot", "*", ""}},
	} {
		before := len(calls())
		rec := c.do(http.MethodPost, tc.path, tc.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s: status = %d body = %s", tc.path, tc.body, rec.Code, rec.Body.String())
		}
		// Mutating routes return the MultiResponse untouched.
		if !strings.Contains(rec.Body.String(), `"success"`) {
			t.Errorf("%s: expected MultiResponse, got %s", tc.path, rec.Body.String())
		}
		got := calls()
		if len(got) != before+1 || got[before] != tc.want {
			t.Errorf("%s %s: upstream = %+v, want %+v", tc.path, tc.body, got[before:], tc.want)
		}
	}
}

func TestSetWorkerVariableValidation(t *testing.T) {
	garage, calls := newFakeNodeGarage(t)
	c := newNodeTestClient(t, garage.URL)
	for _, body := range []string{`{}`, `{"variable":"resync-tranquility"}`, `{"variable":"","value":"1"}`, `not json`, `{"variable":"x","value":1}`} {
		if rec := c.do(http.MethodPost, "/api/nodes/self/worker-variables", body); rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status = %d, want 400", body, rec.Code)
		}
	}
	if n := len(calls()); n != 0 {
		t.Errorf("invalid bodies must not reach Garage, got %d calls", n)
	}
}

// TestNodeRoutesIntegration exercises the read routes and an idempotent
// SetWorkerVariable against a real Garage when GARAGE_TEST_ADMIN_ENDPOINT and
// GARAGE_TEST_ADMIN_TOKEN are set.
func TestNodeRoutesIntegration(t *testing.T) {
	endpoint := os.Getenv("GARAGE_TEST_ADMIN_ENDPOINT")
	if endpoint == "" {
		t.Skip("GARAGE_TEST_ADMIN_ENDPOINT not set")
	}
	admin := &GarageAdminClient{baseURL: endpoint, token: os.Getenv("GARAGE_TEST_ADMIN_TOKEN"), httpClient: &http.Client{Timeout: 10 * time.Second}}
	r := chi.NewRouter()
	r.Route("/api/nodes/{id}", func(r chi.Router) {
		r.Get("/", handleGetNode(admin))
		r.Get("/stats", handleGetNodeStats(admin))
		r.Get("/worker-variables", handleGetNodeWorkerVariables(admin))
		r.Post("/worker-variables", handleSetNodeWorkerVariable(admin))
		r.Get("/workers", handleListNodeWorkers(admin))
	})
	call := func(method, path, body string) (int, []byte) {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Code, rec.Body.Bytes()
	}

	code, body := call(http.MethodGet, "/api/nodes/self", "")
	var info struct {
		NodeID        string `json:"nodeId"`
		GarageVersion string `json:"garageVersion"`
	}
	if code != http.StatusOK || json.Unmarshal(body, &info) != nil || info.NodeID == "" {
		t.Fatalf("info: %d %s", code, body)
	}

	code, body = call(http.MethodGet, "/api/nodes/"+info.NodeID+"/stats", "")
	var stats struct {
		Freeform   string            `json:"freeform"`
		TableStats []json.RawMessage `json:"tableStats"`
	}
	if code != http.StatusOK || json.Unmarshal(body, &stats) != nil || stats.Freeform == "" {
		t.Fatalf("stats: %d %s", code, body)
	}

	code, body = call(http.MethodGet, "/api/nodes/"+info.NodeID[:8]+"/worker-variables", "")
	var vars map[string]string
	if code != http.StatusOK || json.Unmarshal(body, &vars) != nil || vars["resync-tranquility"] == "" {
		t.Fatalf("vars: %d %s", code, body)
	}

	// Writing back the current value leaves the cluster unchanged.
	setBody, _ := json.Marshal(map[string]string{"variable": "resync-tranquility", "value": vars["resync-tranquility"]})
	code, body = call(http.MethodPost, "/api/nodes/self/worker-variables", string(setBody))
	var multi garageMultiResponse
	if code != http.StatusOK || json.Unmarshal(body, &multi) != nil || len(multi.Success) != 1 {
		t.Fatalf("set var: %d %s", code, body)
	}

	code, body = call(http.MethodGet, "/api/nodes/self/workers", "")
	var workers workersResponseDecoded
	if code != http.StatusOK || json.Unmarshal(body, &workers) != nil || len(workers.Workers) == 0 {
		t.Fatalf("workers: %d %s", code, body)
	}
	if workers.Workers[0]["nodeId"] != info.NodeID {
		t.Errorf("worker nodeId = %v, want %s", workers.Workers[0]["nodeId"], info.NodeID)
	}

	if code, _ := call(http.MethodGet, "/api/nodes/0000000000000001", ""); code != http.StatusBadRequest {
		t.Errorf("unknown node: status = %d, want Garage's 400", code)
	}
}

type workersResponseDecoded struct {
	Workers []map[string]any  `json:"workers"`
	Errors  map[string]string `json:"errors"`
}
