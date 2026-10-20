package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// captureLogs redirects the default slog logger to a JSON buffer for the
// duration of the test.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// logLines parses the captured JSON log lines, optionally filtered by msg.
func logLines(t *testing.T, buf *bytes.Buffer, msg string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("invalid log line %q: %v", line, err)
		}
		if msg == "" || m["msg"] == msg {
			out = append(out, m)
		}
	}
	return out
}

// newAuditGarage is a fake Garage Admin API that records the last request body
// it received.
func newAuditGarage(t *testing.T, gotBody *string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		*gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/GetClusterHealth":
			w.Write([]byte(`{"status":"healthy"}`))
		default:
			w.Write([]byte(`{"success":{"n1":null},"error":{}}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestAccessLog_GETHasUserButNoAudit(t *testing.T) {
	var got string
	garage := newAuditGarage(t, &got)
	router, store := setupTestRouter(t, garage.URL)
	buf := captureLogs(t)

	req := authenticatedRequest(t, store, http.MethodGet, "/api/cluster/health", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if n := len(logLines(t, buf, "audit")); n != 0 {
		t.Fatalf("GET produced %d audit lines:\n%s", n, buf.String())
	}
	reqLines := logLines(t, buf, "request")
	if len(reqLines) != 1 {
		t.Fatalf("want 1 request line, got %d:\n%s", len(reqLines), buf.String())
	}
	if reqLines[0]["user"] != "testuser" {
		t.Errorf("request user = %v, want testuser", reqLines[0]["user"])
	}
}

func TestAccessLog_UnauthenticatedOmitsUser(t *testing.T) {
	var got string
	garage := newAuditGarage(t, &got)
	router, _ := setupTestRouter(t, garage.URL)
	buf := captureLogs(t)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))

	lines := logLines(t, buf, "request")
	if len(lines) != 1 {
		t.Fatalf("want 1 request line:\n%s", buf.String())
	}
	if _, ok := lines[0]["user"]; ok {
		t.Errorf("unauthenticated request has user field: %v", lines[0])
	}
}

func TestAudit_MutationRecordsUserRouteParams(t *testing.T) {
	cases := []struct {
		name, method, url, path, route string
		params                         map[string]string
	}{
		{"POST grant key", http.MethodPost, "/api/buckets/b123/keys?node=abc&token=s3cr3t", "/api/buckets/b123/keys",
			"/api/buckets/{id}/keys", map[string]string{"id": "b123"}},
		{"DELETE revoke key", http.MethodDelete, "/api/buckets/b123/keys/GK999?node=abc&token=s3cr3t", "/api/buckets/b123/keys/GK999",
			"/api/buckets/{id}/keys/{kid}", map[string]string{"id": "b123", "kid": "GK999"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got string
			garage := newAuditGarage(t, &got)
			router, store := setupTestRouter(t, garage.URL)
			buf := captureLogs(t)

			body := `{"accessKeyId":"GKsecretish","secretAccessKey":"topsecretvalue","permissions":{"read":true}}`
			req := authenticatedRequest(t, store, tc.method, tc.url, strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Requested-With", "XMLHttpRequest")
			req.Header.Set("Authorization", "Bearer super-secret-auth")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			audits := logLines(t, buf, "audit")
			if len(audits) != 1 {
				t.Fatalf("want 1 audit line, got %d:\n%s", len(audits), buf.String())
			}
			a := audits[0]
			if a["level"] != "INFO" {
				t.Errorf("level = %v", a["level"])
			}
			if a["user"] != "testuser" {
				t.Errorf("user = %v", a["user"])
			}
			if a["method"] != tc.method || a["path"] != tc.path {
				t.Errorf("method/path = %v %v", a["method"], a["path"])
			}
			if a["route"] != tc.route {
				t.Errorf("route = %v, want %v", a["route"], tc.route)
			}
			params, _ := a["params"].(map[string]any)
			if len(params) != len(tc.params) {
				t.Errorf("params = %v, want %v", params, tc.params)
			}
			for k, v := range tc.params {
				if params[k] != v {
					t.Errorf("params[%s] = %v, want %v", k, params[k], v)
				}
			}
			query, _ := a["query"].(map[string]any)
			if query["node"] != "abc" {
				t.Errorf("query = %v", a["query"])
			}
			if _, ok := query["token"]; ok {
				t.Errorf("token query param leaked: %v", query)
			}
			if a["status"] != float64(rec.Code) {
				t.Errorf("status = %v, want %d", a["status"], rec.Code)
			}
			if _, ok := a["duration_ms"]; !ok {
				t.Errorf("duration_ms missing")
			}
			if _, ok := a["detail"]; ok {
				t.Errorf("unexpected detail: %v", a["detail"])
			}

			logs := buf.String()
			for _, secret := range []string{"super-secret-auth", "s3cr3t", "GKsecretish", "topsecretvalue", sessionName} {
				if strings.Contains(logs, secret) {
					t.Errorf("logs contain %q:\n%s", secret, logs)
				}
			}
		})
	}
}

func TestAudit_RepairTypeAndBodyPassthrough(t *testing.T) {
	cases := []struct {
		name, path, body, want string
	}{
		{"cluster string", "/api/repair", `{"repairType":"blockRc"}`, "blockRc"},
		{"node scrub", "/api/nodes/abcdef/repair", `{"repairType":{"scrub":"start"}}`, "scrub:start"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got string
			garage := newAuditGarage(t, &got)
			router, store := setupTestRouter(t, garage.URL)
			buf := captureLogs(t)

			req := authenticatedRequest(t, store, http.MethodPost, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Requested-With", "XMLHttpRequest")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d body %s", rec.Code, rec.Body.String())
			}
			if got != tc.body {
				t.Errorf("garage received body %q, want %q", got, tc.body)
			}
			audits := logLines(t, buf, "audit")
			if len(audits) != 1 {
				t.Fatalf("want 1 audit line:\n%s", buf.String())
			}
			detail, _ := audits[0]["detail"].(map[string]any)
			if detail["repairType"] != tc.want {
				t.Errorf("detail = %v, want repairType %q", audits[0]["detail"], tc.want)
			}
		})
	}
}

func TestAudit_WorkerVariableRecordsNameOnly(t *testing.T) {
	var got string
	garage := newAuditGarage(t, &got)
	router, store := setupTestRouter(t, garage.URL)
	buf := captureLogs(t)

	body := `{"variable":"scrub-tranquility","value":"4321"}`
	req := authenticatedRequest(t, store, http.MethodPost, "/api/nodes/abcdef/worker-variables", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(got, `"4321"`) {
		t.Errorf("downstream did not get the value: %q", got)
	}
	audits := logLines(t, buf, "audit")
	if len(audits) != 1 {
		t.Fatalf("want 1 audit line:\n%s", buf.String())
	}
	detail, _ := audits[0]["detail"].(map[string]any)
	if detail["variable"] != "scrub-tranquility" || len(detail) != 1 {
		t.Errorf("detail = %v", audits[0]["detail"])
	}
	if strings.Contains(buf.String(), "4321") {
		t.Errorf("variable value leaked into logs:\n%s", buf.String())
	}
}

func TestAudit_LargeBodyPassesThroughWithoutDetail(t *testing.T) {
	buf := captureLogs(t)
	var received string
	r := chi.NewRouter()
	r.Use(accessLog)
	r.Post("/api/repair", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		received = string(b)
		w.WriteHeader(http.StatusAccepted)
	})

	body := `{"repairType":"blockRc","pad":"` + strings.Repeat("x", 2*maxAuditBodyBytes) + `"}`
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/repair", strings.NewReader(body)))

	if received != body {
		t.Fatalf("downstream body length %d, want %d", len(received), len(body))
	}
	audits := logLines(t, buf, "audit")
	if len(audits) != 1 {
		t.Fatalf("want 1 audit line:\n%s", buf.String())
	}
	if _, ok := audits[0]["detail"]; ok {
		t.Errorf("oversized body should not yield detail: %v", audits[0]["detail"])
	}
	if audits[0]["status"] != float64(http.StatusAccepted) {
		t.Errorf("status = %v", audits[0]["status"])
	}
	if _, ok := audits[0]["user"]; ok {
		t.Errorf("unauthenticated audit has user: %v", audits[0]["user"])
	}
}

func TestAudit_AuthEndpointsExcluded(t *testing.T) {
	var got string
	garage := newAuditGarage(t, &got)
	router, store := setupTestRouter(t, garage.URL)
	buf := captureLogs(t)

	req := authenticatedRequest(t, store, http.MethodPost, "/api/auth/logout", nil)
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/auth/login", nil))

	if n := len(logLines(t, buf, "audit")); n != 0 {
		t.Fatalf("auth endpoints produced %d audit lines:\n%s", n, buf.String())
	}
	lines := logLines(t, buf, "request")
	if len(lines) != 2 {
		t.Fatalf("want 2 request lines:\n%s", buf.String())
	}
	if lines[0]["user"] != "testuser" {
		t.Errorf("logout request line user = %v", lines[0]["user"])
	}
}

func TestExtractRepairTypeRejectsUnexpectedShapes(t *testing.T) {
	for _, body := range []string{
		`{}`,
		`not json`,
		`{"repairType":42}`,
		`{"repairType":{"scrub":{"nested":"x"}}}`,
		`{"repairType":{"a":"b","c":"d"}}`,
		`{"repairType":"has space\nnewline"}`,
	} {
		if d := extractRepairType([]byte(body)); d != nil {
			t.Errorf("extractRepairType(%s) = %v, want nil", body, d)
		}
	}
}
