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
