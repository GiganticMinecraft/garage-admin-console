package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

const (
	healthNodeA = "aaaa000000000000000000000000000000000000000000000000000000000001"
	healthNodeB = "bbbb000000000000000000000000000000000000000000000000000000000002"
)

// fakeHealthGarage serves the fan-out endpoints with the given
// bodies/statuses (ListWorkers answers with no workers) and counts the calls.
func fakeHealthGarage(t *testing.T, statsStatus int, statsBody string, varsStatus int, varsBody string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	return fakeHealthGarageWithWorkers(t, statsStatus, statsBody, varsStatus, varsBody, http.StatusOK, `{"success":{},"error":{}}`)
}

// fakeHealthGarageWithWorkers is fakeHealthGarage with a ListWorkers answer.
func fakeHealthGarageWithWorkers(t *testing.T, statsStatus int, statsBody string, varsStatus int, varsBody string, workersStatus int, workersBody string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/GetClusterStatus", func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("storage-health must not call GetClusterStatus")
	})
	mux.HandleFunc("/v2/GetNodeStatistics", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodGet || r.URL.Query().Get("node") != "*" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statsStatus)
		w.Write([]byte(statsBody))
	})
	mux.HandleFunc("/v2/GetWorkerVariable", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Query().Get("node") != "*" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(varsStatus)
		w.Write([]byte(varsBody))
	})
	mux.HandleFunc("/v2/ListWorkers", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Query().Get("node") != "*" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(workersStatus)
		w.Write([]byte(workersBody))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &calls
}

func getStorageHealth(t *testing.T, garageURL string) storageHealthResponse {
	t.Helper()
	c := newNodeTestClient(t, garageURL)
	rec := c.do(http.MethodGet, "/api/cluster/storage-health", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got storageHealthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestStorageHealthMergesPerNodeData(t *testing.T) {
	garage, _ := fakeHealthGarage(t,
		http.StatusOK, `{"success":{"`+healthNodeA+`":{"freeform":"","blockManagerStats":{"rcEntries":1,"resyncQueueLen":7,"resyncErrors":2}}},"error":{"`+healthNodeB+`":"Could not reach node"}}`,
		http.StatusOK, `{"success":{"`+healthNodeA+`":{"scrub-corruptions_detected":"3","scrub-last-completed":"2026-10-01T00:00:00Z"}},"error":{"`+healthNodeB+`":"timeout"}}`,
	)
	got := getStorageHealth(t, garage.URL)

	if len(got.Nodes) != 2 || got.StatsError != "" || got.VarsError != "" {
		t.Fatalf("got %+v", got)
	}
	a, b := got.Nodes[healthNodeA], got.Nodes[healthNodeB]
	if a == nil || b == nil {
		t.Fatalf("nodes = %+v", got.Nodes)
	}
	if a.Error != "" || a.ResyncQueueLen == nil || *a.ResyncQueueLen != 7 || *a.ResyncErrors != 2 ||
		a.ScrubCorruptions == nil || *a.ScrubCorruptions != 3 || a.ScrubLastCompleted == nil || *a.ScrubLastCompleted != "2026-10-01T00:00:00Z" {
		t.Errorf("node a = %+v", a)
	}
	if b.ResyncQueueLen != nil || b.ScrubCorruptions != nil {
		t.Errorf("node b should have no metrics: %+v", b)
	}
	if !strings.Contains(b.Error, "Could not reach node") || !strings.Contains(b.Error, "timeout") {
		t.Errorf("node b error = %q", b.Error)
	}
}

func TestStorageHealthFanOutFailureStill200(t *testing.T) {
	garage, _ := fakeHealthGarage(t,
		http.StatusInternalServerError, `{"code":"InternalError","message":"boom"}`,
		http.StatusOK, `{"success":{"`+healthNodeA+`":{"scrub-corruptions_detected":"0","scrub-last-completed":"never"}},"error":{}}`,
	)
	got := getStorageHealth(t, garage.URL)
	if got.StatsError != statsUnavailableMsg+": boom" {
		t.Errorf("statsError = %q", got.StatsError)
	}
	a := got.Nodes[healthNodeA]
	if a == nil || a.ResyncQueueLen != nil || a.Error != "" || a.ScrubCorruptions == nil || *a.ScrubCorruptions != 0 {
		t.Errorf("node a = %+v", a)
	}
}

func TestStorageHealthHidesTransportErrors(t *testing.T) {
	garage, _ := fakeHealthGarage(t, http.StatusOK, `{}`, http.StatusOK, `{}`)
	url := garage.URL
	garage.Close() // connection refused: the error text would contain the URL
	got := getStorageHealth(t, url)
	if got.StatsError != statsUnavailableMsg || got.VarsError != varsUnavailableMsg {
		t.Errorf("got %+v", got)
	}
	raw, _ := json.Marshal(got)
	if strings.Contains(string(raw), "127.0.0.1") {
		t.Errorf("response leaks the upstream address: %s", raw)
	}
}

func TestStorageHealthReportsMissingOrBadCorruptionCounter(t *testing.T) {
	garage, _ := fakeHealthGarage(t,
		http.StatusOK, `{"success":{"`+healthNodeA+`":{"freeform":"x"},"`+healthNodeB+`":{"freeform":"x","blockManagerStats":{"rcEntries":0,"resyncQueueLen":0,"resyncErrors":0}}},"error":{}}`,
		http.StatusOK, `{"success":{"`+healthNodeA+`":{"scrub-last-completed":"never"},"`+healthNodeB+`":{"scrub-corruptions_detected":"lots"}},"error":{}}`,
	)
	got := getStorageHealth(t, garage.URL)
	a, b := got.Nodes[healthNodeA], got.Nodes[healthNodeB]
	if !strings.Contains(a.Error, "blockManagerStats not reported") || !strings.Contains(a.Error, "報告されていません") {
		t.Errorf("node a error = %q", a.Error)
	}
	if b.ScrubCorruptions != nil || !strings.Contains(b.Error, "解釈できません") {
		t.Errorf("node b = %+v", b)
	}
}

func TestStorageHealthNodeMissingFromOneFanOut(t *testing.T) {
	garage, _ := fakeHealthGarage(t,
		http.StatusOK, `{"success":{"`+healthNodeA+`":{"freeform":"","blockManagerStats":{"rcEntries":0,"resyncQueueLen":0,"resyncErrors":0}}},"error":{}}`,
		http.StatusOK, `{"success":{},"error":{}}`,
	)
	got := getStorageHealth(t, garage.URL)
	if a := got.Nodes[healthNodeA]; a == nil || !strings.Contains(a.Error, "worker 変数: "+nodeNotAnsweredMsg) {
		t.Errorf("node a = %+v", a)
	}
}

func TestStorageHealthIsCached(t *testing.T) {
	garage, calls := fakeHealthGarage(t,
		http.StatusOK, `{"success":{},"error":{}}`,
		http.StatusOK, `{"success":{},"error":{}}`,
	)
	getStorageHealth(t, garage.URL)
	getStorageHealth(t, garage.URL)
	if n := calls.Load(); n != 3 {
		t.Errorf("upstream calls = %d, want 3 (one fan-out of three requests, then cached)", n)
	}
}

func TestStorageHealthScrubWorker(t *testing.T) {
	const okStats = `{"freeform":"","blockManagerStats":{"rcEntries":0,"resyncQueueLen":0,"resyncErrors":0}}`
	const okVars = `{"scrub-corruptions_detected":"5","scrub-last-completed":"never"}`
	garage, _ := fakeHealthGarageWithWorkers(t,
		http.StatusOK, `{"success":{"`+healthNodeA+`":`+okStats+`,"`+healthNodeB+`":`+okStats+`},"error":{}}`,
		http.StatusOK, `{"success":{"`+healthNodeA+`":`+okVars+`,"`+healthNodeB+`":`+okVars+`},"error":{}}`,
		http.StatusOK, `{"success":{
			"`+healthNodeA+`":[
				{"id":1,"name":"Block resync worker #1","state":"idle","errors":0,"consecutiveErrors":0,"freeform":[]},
				{"id":2,"name":"Block scrub worker","state":{"throttled":{"durationSecs":0.5}},"errors":0,"consecutiveErrors":0,"tranquility":4,"progress":"12.50%","persistentErrors":5,"freeform":[]}
			],
			"`+healthNodeB+`":[
				{"id":1,"name":"Block resync worker #1","state":"busy","errors":0,"consecutiveErrors":0,"freeform":[]}
			]},"error":{}}`,
	)
	got := getStorageHealth(t, garage.URL)
	a, b := got.Nodes[healthNodeA], got.Nodes[healthNodeB]
	if a == nil || a.Scrub == nil || string(a.Scrub.State) != `{"throttled":{"durationSecs":0.5}}` || a.Scrub.Progress == nil || *a.Scrub.Progress != "12.50%" ||
		a.Scrub.Tranquility == nil || *a.Scrub.Tranquility != 4 || a.Error != "" {
		t.Errorf("node a = %+v scrub = %+v", a, a.Scrub)
	}
	// No scrub worker listed: null, and not an error.
	if b == nil || b.Scrub != nil || b.Error != "" {
		t.Errorf("node b = %+v", b)
	}
}

func TestStorageHealthScrubWorkerIdleAndFanOutFailure(t *testing.T) {
	const stats = `{"success":{"` + healthNodeA + `":{"freeform":"","blockManagerStats":{"rcEntries":0,"resyncQueueLen":0,"resyncErrors":0}}},"error":{}}`
	const vars = `{"success":{"` + healthNodeA + `":{"scrub-corruptions_detected":"0"}},"error":{}}`
	garage, _ := fakeHealthGarageWithWorkers(t, http.StatusOK, stats, http.StatusOK, vars,
		http.StatusOK, `{"success":{"`+healthNodeA+`":[{"id":3,"name":"Block scrub worker","state":"idle","errors":0,"consecutiveErrors":0,"tranquility":2,"freeform":["Last scrub completed at x"]}]},"error":{}}`)
	got := getStorageHealth(t, garage.URL)
	if s := got.Nodes[healthNodeA].Scrub; s == nil || string(s.State) != `"idle"` || s.Progress != nil {
		t.Errorf("scrub = %+v", s)
	}
	raw, _ := json.Marshal(got.Nodes[healthNodeA].Scrub)
	if strings.Contains(string(raw), "progress") {
		t.Errorf("progress should be omitted when absent: %s", raw)
	}

	// A new fake has a new URL, so the cache (keyed by base URL) misses.
	garage, _ = fakeHealthGarageWithWorkers(t, http.StatusOK, stats, http.StatusOK, vars,
		http.StatusInternalServerError, `{"code":"InternalError","message":"boom"}`)
	got = getStorageHealth(t, garage.URL)
	a := got.Nodes[healthNodeA]
	if got.WorkersError != workersUnavailableMsg+": boom" || a.Scrub != nil || a.Error != "" || a.ScrubCorruptions == nil {
		t.Errorf("got %+v node a = %+v", got, a)
	}
}

func TestStorageHealthScrubWorkerNodeErrorAndOnlyWorkersAnswered(t *testing.T) {
	// Stats and vars fail as a whole; ListWorkers answers for A and fails on B.
	garage, _ := fakeHealthGarageWithWorkers(t,
		http.StatusInternalServerError, `{"message":"boom"}`,
		http.StatusInternalServerError, `{"message":"boom"}`,
		http.StatusOK, `{"success":{"`+healthNodeA+`":[{"id":2,"name":"Block scrub worker","state":"busy","progress":"1.00%","errors":0,"consecutiveErrors":0,"freeform":[]}]},"error":{"`+healthNodeB+`":"Could not reach node"}}`)
	got := getStorageHealth(t, garage.URL)
	a, b := got.Nodes[healthNodeA], got.Nodes[healthNodeB]
	if a == nil || a.Scrub == nil || string(a.Scrub.State) != `"busy"` || a.Error != "" {
		t.Errorf("node a = %+v", a)
	}
	if b == nil || b.Scrub != nil || b.Error != "worker 一覧: Could not reach node" {
		t.Errorf("node b = %+v", b)
	}
}

func TestClusterStatisticsProxy(t *testing.T) {
	const body = `{"freeform":"...","dataAvail":100,"metadataAvail":50,"incompleteAvailInfo":true,"bucketCount":3,"totalObjectCount":10,"totalObjectBytes":2048}`
	var gotMethod string
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/GetClusterStatistics", func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(body))
	})
	garage := httptest.NewServer(mux)
	defer garage.Close()
	rec := newNodeTestClient(t, garage.URL).do(http.MethodGet, "/api/cluster/statistics", "")
	if rec.Code != http.StatusOK || rec.Body.String() != body || gotMethod != http.MethodGet {
		t.Errorf("status = %d method = %s body = %s", rec.Code, gotMethod, rec.Body.String())
	}
}

// TestStorageHealthIntegration runs against a real Garage when
// GARAGE_TEST_ADMIN_ENDPOINT / GARAGE_TEST_ADMIN_TOKEN are set.
func TestStorageHealthIntegration(t *testing.T) {
	endpoint, token := os.Getenv("GARAGE_TEST_ADMIN_ENDPOINT"), os.Getenv("GARAGE_TEST_ADMIN_TOKEN")
	if endpoint == "" || token == "" {
		t.Skip("GARAGE_TEST_ADMIN_ENDPOINT / GARAGE_TEST_ADMIN_TOKEN not set")
	}
	garageAdmin := &GarageAdminClient{baseURL: endpoint, token: token, httpClient: http.DefaultClient}

	rec := httptest.NewRecorder()
	handleStorageHealth(garageAdmin)(rec, httptest.NewRequest(http.MethodGet, "/api/cluster/storage-health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("storage-health status = %d body = %s", rec.Code, rec.Body.String())
	}
	var resp storageHealthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Nodes) == 0 || resp.StatsError != "" || resp.VarsError != "" {
		t.Fatalf("resp = %s", rec.Body.String())
	}
	for id, n := range resp.Nodes {
		if n.Error != "" || n.ResyncQueueLen == nil || n.ScrubCorruptions == nil || n.ScrubLastCompleted == nil {
			t.Errorf("node %s %+v: want every metric", id, n)
		}
	}

	rec = httptest.NewRecorder()
	handleClusterStatistics(garageAdmin)(rec, httptest.NewRequest(http.MethodGet, "/api/cluster/statistics", nil))
	var stats struct {
		DataAvail   *int64 `json:"dataAvail"`
		BucketCount *int64 `json:"bucketCount"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &stats) != nil || stats.DataAvail == nil || stats.BucketCount == nil {
		t.Errorf("statistics status = %d body = %s", rec.Code, rec.Body.String())
	}
}
