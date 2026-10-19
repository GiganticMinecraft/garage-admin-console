package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

const (
	healthNodeA   = "aaaa000000000000000000000000000000000000000000000000000000000001"
	healthNodeB   = "bbbb000000000000000000000000000000000000000000000000000000000002"
	healthGateway = "cccc000000000000000000000000000000000000000000000000000000000003"
)

// fakeHealthGarage serves GetClusterStatus with two storage nodes and a
// gateway, plus the two fan-out endpoints with the given bodies/statuses.
func fakeHealthGarage(t *testing.T, statsStatus int, statsBody string, varsStatus int, varsBody string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/GetClusterStatus", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"layoutVersion":3,"nodes":[
			{"id":"` + healthNodeB + `","hostname":"node-b","isUp":false,"role":{"zone":"z","tags":[],"capacity":100}},
			{"id":"` + healthNodeA + `","hostname":"node-a","isUp":true,"role":{"zone":"z","tags":[],"capacity":100}},
			{"id":"` + healthGateway + `","hostname":"gw","isUp":true,"role":{"zone":"z","tags":[],"capacity":null}}
		]}`))
	})
	mux.HandleFunc("/v2/GetNodeStatistics", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Query().Get("node") != "*" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statsStatus)
		w.Write([]byte(statsBody))
	})
	mux.HandleFunc("/v2/GetWorkerVariable", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Query().Get("node") != "*" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(varsStatus)
		w.Write([]byte(varsBody))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func getStorageHealth(t *testing.T, garageURL string) []storageNodeHealth {
	t.Helper()
	c := newNodeTestClient(t, garageURL)
	rec := c.do(http.MethodGet, "/api/cluster/storage-health", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got []storageNodeHealth
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestStorageHealthMergesPerNodeData(t *testing.T) {
	garage := fakeHealthGarage(t,
		http.StatusOK, `{"success":{"`+healthNodeA+`":{"freeform":"","blockManagerStats":{"rcEntries":1,"resyncQueueLen":7,"resyncErrors":2}}},"error":{"`+healthNodeB+`":"Could not reach node"}}`,
		http.StatusOK, `{"success":{"`+healthNodeA+`":{"scrub-corruptions_detected":"3","scrub-last-completed":"2026-10-01T00:00:00Z"}},"error":{"`+healthNodeB+`":"timeout"}}`,
	)
	got := getStorageHealth(t, garage.URL)

	if len(got) != 2 {
		t.Fatalf("want 2 storage nodes (gateway excluded), got %+v", got)
	}
	a, b := got[0], got[1]
	if a.ID != healthNodeA || b.ID != healthNodeB {
		t.Fatalf("order = %s, %s; want sorted by hostname", a.ID, b.ID)
	}
	if a.Error != "" || a.ResyncQueueLen == nil || *a.ResyncQueueLen != 7 || *a.ResyncErrors != 2 ||
		a.ScrubCorruptions == nil || *a.ScrubCorruptions != 3 || derefString(a.ScrubLastCompleted) != "2026-10-01T00:00:00Z" ||
		derefString(a.Hostname) != "node-a" || !a.IsUp {
		t.Errorf("node a = %+v", a)
	}
	if b.ResyncQueueLen != nil || b.ScrubCorruptions != nil || b.IsUp {
		t.Errorf("node b should have no metrics: %+v", b)
	}
	if !strings.Contains(b.Error, "Could not reach node") || !strings.Contains(b.Error, "timeout") {
		t.Errorf("node b error = %q", b.Error)
	}
}

func TestStorageHealthFanOutFailureStill200(t *testing.T) {
	garage := fakeHealthGarage(t,
		http.StatusInternalServerError, `{"code":"InternalError","message":"boom"}`,
		http.StatusOK, `{"success":{"`+healthNodeA+`":{"scrub-corruptions_detected":"0","scrub-last-completed":"never"},"`+healthNodeB+`":{"scrub-corruptions_detected":"0"}},"error":{}}`,
	)
	got := getStorageHealth(t, garage.URL)
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	for _, n := range got {
		if n.ResyncQueueLen != nil || !strings.Contains(n.Error, "boom") {
			t.Errorf("node %s: want stats error, got %+v", n.ID, n)
		}
		if n.ScrubCorruptions == nil || *n.ScrubCorruptions != 0 {
			t.Errorf("node %s: worker variables should still be filled: %+v", n.ID, n)
		}
	}
	if derefString(got[0].ScrubLastCompleted) != "never" || got[1].ScrubLastCompleted != nil {
		t.Errorf("scrubLastCompleted = %v, %v", got[0].ScrubLastCompleted, got[1].ScrubLastCompleted)
	}
}

func TestStorageHealthOldGarageWithoutBlockStats(t *testing.T) {
	garage := fakeHealthGarage(t,
		http.StatusOK, `{"success":{"`+healthNodeA+`":{"freeform":"x"},"`+healthNodeB+`":{"freeform":"x"}},"error":{}}`,
		http.StatusOK, `{"success":{"`+healthNodeA+`":{},"`+healthNodeB+`":{}},"error":{}}`,
	)
	got := getStorageHealth(t, garage.URL)
	for _, n := range got {
		if !strings.Contains(n.Error, "blockManagerStats not reported") {
			t.Errorf("node %s error = %q", n.ID, n.Error)
		}
	}
}

func TestStorageHealthForwardsClusterStatusError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/GetClusterStatus", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"code":"NoQuorum","message":"no quorum"}`))
	})
	garage := httptest.NewServer(mux)
	defer garage.Close()
	rec := newNodeTestClient(t, garage.URL).do(http.MethodGet, "/api/cluster/storage-health", "")
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "no quorum") {
		t.Errorf("status = %d body = %s", rec.Code, rec.Body.String())
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
	var nodes []storageNodeHealth
	if err := json.Unmarshal(rec.Body.Bytes(), &nodes); err != nil {
		t.Fatal(err)
	}
	if len(nodes) == 0 {
		t.Fatal("no storage nodes")
	}
	for _, n := range nodes {
		if n.Error != "" || n.ResyncQueueLen == nil || n.ScrubCorruptions == nil || n.ScrubLastCompleted == nil {
			t.Errorf("node %+v: want every metric", n)
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
