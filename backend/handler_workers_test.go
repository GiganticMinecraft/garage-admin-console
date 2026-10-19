package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFlattenWorkersTagsNodeAndSorts(t *testing.T) {
	success := map[string][]json.RawMessage{
		"bbb": {json.RawMessage(`{"id":2,"name":"w2"}`), json.RawMessage(`{"id":1,"name":"w1"}`)},
		"aaa": {json.RawMessage(`{"id":5,"name":"w5"}`)},
	}
	errors := map[string]string{"ccc": "Not connected"}

	out := flattenWorkers(success, errors)
	b, _ := json.Marshal(out)
	var decoded struct {
		Workers []map[string]any  `json:"workers"`
		Errors  map[string]string `json:"errors"`
	}
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, len(decoded.Workers))
	for _, w := range decoded.Workers {
		got = append(got, w["nodeId"].(string)+"/"+w["name"].(string))
	}
	want := "aaa/w5 bbb/w1 bbb/w2"
	if strings.Join(got, " ") != want {
		t.Errorf("order = %v, want %s", got, want)
	}
	if decoded.Errors["ccc"] != "Not connected" {
		t.Errorf("errors = %v", decoded.Errors)
	}
}

func TestFlattenWorkersEmpty(t *testing.T) {
	b, _ := json.Marshal(flattenWorkers(nil, nil))
	if s := string(b); s != `{"workers":[],"errors":{}}` {
		t.Errorf("empty response = %s", s)
	}
}

func TestAggregateNodeStatistics(t *testing.T) {
	var multi nodeStatisticsMulti
	err := json.Unmarshal([]byte(`{
		"success": {
			"n2": {"freeform":"...","blockManagerStats":{"rcEntries":1,"resyncQueueLen":300,"resyncErrors":40}},
			"n1": {"freeform":"...","blockManagerStats":{"rcEntries":1,"resyncQueueLen":32,"resyncErrors":3}},
			"old": {"freeform":"..."}
		},
		"error": {"n3": "Not connected: n3"}
	}`), &multi)
	if err != nil {
		t.Fatal(err)
	}
	got := aggregateNodeStatistics(multi)
	if got.ResyncQueueLength != 332 || got.ResyncErrored != 43 {
		t.Errorf("sums = %d/%d, want 332/43", got.ResyncQueueLength, got.ResyncErrored)
	}
	if len(got.Nodes) != 2 || got.Nodes[0].NodeID != "n1" || got.Nodes[1].NodeID != "n2" {
		t.Errorf("nodes = %+v", got.Nodes)
	}
	if got.NodeErrors["n3"] == "" || got.NodeErrors["old"] == "" {
		t.Errorf("nodeErrors = %v", got.NodeErrors)
	}
}

// TestMaintenanceMetricsHandler covers the full handler. It must not read
// Garage's /metrics: the scrub corruption count comes from storage-health.
func TestMaintenanceMetricsHandler(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/GetNodeStatistics", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("node") != "*" {
			t.Errorf("node param = %q, want *", r.URL.Query().Get("node"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success":{"a":{"blockManagerStats":{"resyncQueueLen":1,"resyncErrors":2}},"b":{"blockManagerStats":{"resyncQueueLen":10,"resyncErrors":20}}},"error":{"c":"Not connected"}}`))
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		t.Error("/metrics should not be requested")
	})
	garage := httptest.NewServer(mux)
	defer garage.Close()
	handler, store := setupTestRouter(t, garage.URL)

	req := authenticatedRequest(t, store, http.MethodGet, "/api/metrics", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw["corruptionCounter"]; ok {
		t.Errorf("corruptionCounter should no longer be served: %s", rec.Body.String())
	}
	var got maintenanceMetrics
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.ResyncQueueLength != 11 || got.ResyncErrored != 22 {
		t.Errorf("sums = %d/%d", got.ResyncQueueLength, got.ResyncErrored)
	}
	if len(got.Nodes) != 2 || got.NodeErrors["c"] != "Not connected" {
		t.Errorf("nodes = %+v nodeErrors = %v", got.Nodes, got.NodeErrors)
	}
}
