package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestLayoutWorkflowRoutesProxyToGarage(t *testing.T) {
	var calls []string
	mux := http.NewServeMux()
	record := func(path string) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			body, _ := readAll(r)
			calls = append(calls, r.Method+" "+path+" "+body)
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"ok":true}`))
		})
	}
	record("/v2/UpdateClusterLayout")
	record("/v2/PreviewClusterLayoutChanges")
	record("/v2/ApplyClusterLayout")
	record("/v2/RevertClusterLayout")
	garage := httptest.NewServer(mux)
	defer garage.Close()
	handler, store := setupTestRouter(t, garage.URL)

	for _, tc := range []struct{ path, body string }{
		{"/api/cluster/layout/stage", `{"roles":[{"id":"n1","zone":"dc1","capacity":1,"tags":[]}]}`},
		{"/api/cluster/layout/preview", `{}`},
		{"/api/cluster/layout/apply", `{"version":2}`},
		{"/api/cluster/layout/revert", `{}`},
	} {
		req := authenticatedRequest(t, store, http.MethodPost, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d body = %s", tc.path, rec.Code, rec.Body.String())
		}
	}
	want := []string{
		`POST /v2/UpdateClusterLayout {"roles":[{"id":"n1","zone":"dc1","capacity":1,"tags":[]}]}`,
		`POST /v2/PreviewClusterLayoutChanges {}`,
		`POST /v2/ApplyClusterLayout {"version":2}`,
		`POST /v2/RevertClusterLayout {}`,
	}
	if strings.Join(calls, "\n") != strings.Join(want, "\n") {
		t.Errorf("upstream calls:\n%s\nwant:\n%s", strings.Join(calls, "\n"), strings.Join(want, "\n"))
	}
}

func TestLayoutHistoryAndSkipDeadNodesProxyToGarage(t *testing.T) {
	var calls []string
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/GetClusterLayoutHistory", func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" /v2/GetClusterLayoutHistory")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"currentVersion":3,"minAck":2,"versions":[{"version":3,"status":"Current","storageNodes":2,"gatewayNodes":0},{"version":2,"status":"Draining","storageNodes":2,"gatewayNodes":0}],"updateTrackers":{"n1":{"ack":3,"sync":2,"syncAck":2}}}`))
	})
	mux.HandleFunc("/v2/ClusterLayoutSkipDeadNodes", func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAll(r)
		calls = append(calls, r.Method+" /v2/ClusterLayoutSkipDeadNodes "+body)
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(body, `"version":9`) {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"code":"InvalidRequest","message":"Bad request: Invalid version, you may use the following version numbers: 3"}`))
			return
		}
		w.Write([]byte(`{"ackUpdated":["n2"],"syncUpdated":[]}`))
	})
	garage := httptest.NewServer(mux)
	defer garage.Close()
	handler, store := setupTestRouter(t, garage.URL)

	req := authenticatedRequest(t, store, http.MethodGet, "/api/cluster/layout/history", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("history: status = %d body = %s", rec.Code, rec.Body.String())
	}
	var hist struct {
		CurrentVersion int                       `json:"currentVersion"`
		MinAck         int                       `json:"minAck"`
		UpdateTrackers map[string]map[string]int `json:"updateTrackers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &hist); err != nil {
		t.Fatalf("history body: %v", err)
	}
	if hist.CurrentVersion != 3 || hist.MinAck != 2 || hist.UpdateTrackers["n1"]["syncAck"] != 2 {
		t.Errorf("history = %+v", hist)
	}

	post := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		req := authenticatedRequest(t, store, http.MethodPost, "/api/cluster/layout/skip-dead-nodes", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	if rec := post(`{"version":3,"allowMissingData":false}`); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ackUpdated":["n2"]`) {
		t.Fatalf("skip-dead-nodes: status = %d body = %s", rec.Code, rec.Body.String())
	}
	// Garage's 400 (and its message) must reach the client unchanged so the dialog can show it.
	if rec := post(`{"version":9,"allowMissingData":true}`); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Invalid version") {
		t.Fatalf("skip-dead-nodes error: status = %d body = %s", rec.Code, rec.Body.String())
	}

	want := []string{
		`GET /v2/GetClusterLayoutHistory`,
		`POST /v2/ClusterLayoutSkipDeadNodes {"version":3,"allowMissingData":false}`,
		`POST /v2/ClusterLayoutSkipDeadNodes {"version":9,"allowMissingData":true}`,
	}
	if strings.Join(calls, "\n") != strings.Join(want, "\n") {
		t.Errorf("upstream calls:\n%s\nwant:\n%s", strings.Join(calls, "\n"), strings.Join(want, "\n"))
	}
}

func TestSkipDeadNodesRequiresCSRFHeader(t *testing.T) {
	called := false
	garage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer garage.Close()
	handler, store := setupTestRouter(t, garage.URL)
	req := authenticatedRequest(t, store, http.MethodPost, "/api/cluster/layout/skip-dead-nodes", strings.NewReader(`{"version":2,"allowMissingData":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code == http.StatusOK || called {
		t.Fatalf("skip-dead-nodes without X-Requested-With reached Garage: status = %d", rec.Code)
	}
}

// TestLayoutHistoryIntegration reads the layout history from a real Garage
// and checks that skip-dead-nodes forwards Garage's own validation error.
// It never changes the layout: on a cluster with a single live version Garage
// refuses the skip, and on a cluster with an update in flight the test only
// sends an out-of-range version, which Garage also rejects.
func TestLayoutHistoryIntegration(t *testing.T) {
	endpoint := os.Getenv("GARAGE_TEST_ADMIN_ENDPOINT")
	if endpoint == "" {
		t.Skip("GARAGE_TEST_ADMIN_ENDPOINT not set")
	}
	admin := &GarageAdminClient{baseURL: endpoint, token: os.Getenv("GARAGE_TEST_ADMIN_TOKEN"), httpClient: &http.Client{Timeout: 10 * time.Second}}
	r := chi.NewRouter()
	r.Get("/api/cluster/layout/history", handleLayoutHistory(admin))
	r.Post("/api/cluster/layout/skip-dead-nodes", handleSkipDeadNodes(admin))

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/cluster/layout/history", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("history: %d %s", rec.Code, rec.Body.String())
	}
	var hist struct {
		CurrentVersion int64 `json:"currentVersion"`
		MinAck         int64 `json:"minAck"`
		Versions       []struct {
			Version int64  `json:"version"`
			Status  string `json:"status"`
		} `json:"versions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &hist); err != nil {
		t.Fatalf("history body: %v", err)
	}
	if hist.CurrentVersion == 0 || len(hist.Versions) == 0 || hist.Versions[0].Status != "Current" {
		t.Fatalf("unexpected history: %s", rec.Body.String())
	}

	// currentVersion+1 is never a valid target, so Garage must refuse it whatever the cluster state.
	body := fmt.Sprintf(`{"version":%d,"allowMissingData":false}`, hist.CurrentVersion+1)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/cluster/layout/skip-dead-nodes", strings.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("skip-dead-nodes: status = %d body = %s, want 400", rec.Code, rec.Body.String())
	}
	var garageErr struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &garageErr); err != nil || garageErr.Message == "" {
		t.Fatalf("skip-dead-nodes error body not forwarded: %s", rec.Body.String())
	}
}

func readAll(r *http.Request) (string, error) {
	b, err := io.ReadAll(r.Body)
	return string(b), err
}

// TestLayoutWorkflowIntegration drives stage -> preview -> revert and
// stage -> apply against a real Garage when GARAGE_TEST_ADMIN_ENDPOINT and
// GARAGE_TEST_ADMIN_TOKEN are set. It requires a cluster with an applied
// layout and restores the original capacity afterwards.
func TestLayoutWorkflowIntegration(t *testing.T) {
	endpoint := os.Getenv("GARAGE_TEST_ADMIN_ENDPOINT")
	if endpoint == "" {
		t.Skip("GARAGE_TEST_ADMIN_ENDPOINT not set")
	}
	admin := &GarageAdminClient{baseURL: endpoint, token: os.Getenv("GARAGE_TEST_ADMIN_TOKEN"), httpClient: &http.Client{Timeout: 10 * time.Second}}
	r := chi.NewRouter()
	r.Get("/api/cluster/layout", handleClusterLayout(admin))
	r.Post("/api/cluster/layout/stage", handleStageLayout(admin))
	r.Post("/api/cluster/layout/preview", handlePreviewLayout(admin))
	r.Post("/api/cluster/layout/apply", handleApplyLayout(admin))
	r.Post("/api/cluster/layout/revert", handleRevertLayout(admin))

	call := func(method, path, body string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(context.Background())
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}

	_, layout := call(http.MethodGet, "/api/cluster/layout", "")
	roles, _ := layout["roles"].([]any)
	// Pick the first storage node; gateway roles have capacity null.
	var role map[string]any
	for _, r := range roles {
		if m, ok := r.(map[string]any); ok {
			if _, ok := m["capacity"].(float64); ok {
				role = m
				break
			}
		}
	}
	if role == nil {
		t.Skip("cluster has no applied storage role")
	}
	nodeID := role["id"].(string)
	zone := role["zone"].(string)
	origCap := role["capacity"].(float64)
	version := layout["version"].(float64)
	// Preserve the node's tags so the test leaves the cluster as it found it.
	tags, _ := json.Marshal(role["tags"])

	stage := func(capacity float64) {
		t.Helper()
		body := fmt.Sprintf(`{"roles":[{"id":%q,"zone":%q,"capacity":%d,"tags":%s}]}`, nodeID, zone, int64(capacity), tags)
		if code, out := call(http.MethodPost, "/api/cluster/layout/stage", body); code != http.StatusOK {
			t.Fatalf("stage: %d %v", code, out)
		}
	}
	applyBody := func(v float64) string { return fmt.Sprintf(`{"version":%d}`, int64(v)) }

	// 1. stage -> preview -> revert leaves the layout untouched.
	stage(origCap + 1<<30)
	if code, out := call(http.MethodPost, "/api/cluster/layout/preview", "{}"); code != http.StatusOK || out["newLayout"] == nil {
		t.Fatalf("preview: %d %v", code, out)
	}
	if code, _ := call(http.MethodPost, "/api/cluster/layout/revert", "{}"); code != http.StatusOK {
		t.Fatalf("revert failed: %d", code)
	}
	if _, l := call(http.MethodGet, "/api/cluster/layout", ""); len(l["stagedRoleChanges"].([]any)) != 0 {
		t.Fatalf("staged changes remain after revert: %v", l["stagedRoleChanges"])
	}

	// 2. apply with the current version must be rejected (regression guard for the old UI).
	if code, _ := call(http.MethodPost, "/api/cluster/layout/apply", applyBody(version)); code == http.StatusOK {
		t.Fatalf("apply with current version should fail")
	}

	// 3. stage -> apply with version+1 succeeds, then restore.
	stage(origCap + 1<<30)
	if code, out := call(http.MethodPost, "/api/cluster/layout/apply", applyBody(version+1)); code != http.StatusOK {
		t.Fatalf("apply: %d %v", code, out)
	}
	stage(origCap)
	if code, out := call(http.MethodPost, "/api/cluster/layout/apply", applyBody(version+2)); code != http.StatusOK {
		t.Fatalf("restore apply: %d %v", code, out)
	}
	_, final := call(http.MethodGet, "/api/cluster/layout", "")
	if final["version"].(float64) != version+2 {
		t.Errorf("final version = %v, want %v", final["version"], version+2)
	}
}
