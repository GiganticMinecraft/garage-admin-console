package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
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
		{"POST grant key", http.MethodPost, "/api/buckets/b123/keys?accessKeyId=GKq&token=s3cr3t", "/api/buckets/b123/keys",
			"/api/buckets/{id}/keys", map[string]string{"id": "b123"}},
		{"DELETE revoke key", http.MethodDelete, "/api/buckets/b123/keys/GK999?accessKeyId=GKq&token=s3cr3t", "/api/buckets/b123/keys/GK999",
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
			if query["accessKeyId"] != "GKq" || len(query) != 1 {
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

	body := `{"variable":"scrub-tranquility","value":"4321","allNodes":true}`
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
	if detail["variable"] != "scrub-tranquility" || detail["allNodes"] != true || len(detail) != 2 {
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

func TestAudit_AuthEndpointsExcludedButLogoutAudited(t *testing.T) {
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

	// Only the handler's logout event; the middleware skips /api/auth/*.
	audits := logLines(t, buf, "audit")
	if len(audits) != 1 {
		t.Fatalf("want 1 audit line (logout event), got %d:\n%s", len(audits), buf.String())
	}
	if audits[0]["event"] != "logout" || audits[0]["user"] != "testuser" {
		t.Errorf("logout audit = %v", audits[0])
	}
	if _, ok := audits[0]["route"]; ok {
		t.Errorf("middleware audit line emitted for /api/auth/*: %v", audits[0])
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
		if d := extractRepairType([]byte(body), true); d != nil {
			t.Errorf("extractRepairType(%s) = %v, want nil", body, d)
		}
	}
}

// rewriteTransport sends every request to target, keeping the path, so code
// that calls https://api.github.com can be pointed at an httptest server.
type rewriteTransport struct{ target string }

func (rt rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	u, _ := url.Parse(rt.target)
	req = req.Clone(req.Context())
	req.URL.Scheme = u.Scheme
	req.URL.Host = u.Host
	return http.DefaultTransport.RoundTrip(req)
}

func TestAudit_LoginEvent(t *testing.T) {
	router, store := setupTestRouter(t, "http://127.0.0.1:1")

	fakeGitHub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/login/oauth/access_token":
			w.Write([]byte(`{"access_token":"gho_supersecrettoken","token_type":"bearer"}`))
		case r.URL.Path == "/user":
			w.Write([]byte(`{"login":"octocat","avatar_url":"https://example.com/a.png"}`))
		case strings.Contains(r.URL.Path, "/memberships/"):
			w.Write([]byte(`{"state":"active"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(fakeGitHub.Close)
	oauthConfig.Endpoint.TokenURL = fakeGitHub.URL + "/login/oauth/access_token"
	prevHTTP := githubHTTP
	githubHTTP = &http.Client{Transport: rewriteTransport{fakeGitHub.URL}}
	t.Cleanup(func() { githubHTTP = prevHTTP })

	buf := captureLogs(t)

	req := httptest.NewRequest(http.MethodGet, "/api/auth/callback?state=st4te&code=c0de-secret", nil)
	sess, _ := store.New(req, sessionName)
	sess.Values[sessionKeyState] = "st4te"
	saveRec := httptest.NewRecorder()
	sess.Save(req, saveRec)
	for _, c := range saveRec.Result().Cookies() {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("callback status = %d body %s\n%s", rec.Code, rec.Body.String(), buf.String())
	}

	audits := logLines(t, buf, "audit")
	if len(audits) != 1 || audits[0]["event"] != "login" || audits[0]["user"] != "octocat" {
		t.Fatalf("want 1 login audit for octocat:\n%s", buf.String())
	}
	for _, secret := range []string{"gho_supersecrettoken", "c0de-secret", "st4te"} {
		if strings.Contains(buf.String(), secret) {
			t.Errorf("logs contain %q:\n%s", secret, buf.String())
		}
	}
}

// newStubAuditRouter mounts accessLog (outside Recoverer, as in newRouter) and
// a stub handler on pattern that records the body it receives and answers
// with respBody.
func newStubAuditRouter(method, pattern, respBody string, received *string) http.Handler {
	r := chi.NewRouter()
	r.Use(accessLog)
	r.Use(middleware.Recoverer)
	r.MethodFunc(method, pattern, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		*received = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(respBody))
	})
	return r
}

func TestAudit_DestructiveOperationDetails(t *testing.T) {
	manyKeys := make([]string, 0, 400)
	for i := 0; i < 400; i++ {
		manyKeys = append(manyKeys, fmt.Sprintf("dir/object-%04d.bin", i))
	}
	manyKeysBody, _ := json.Marshal(map[string]any{"keys": manyKeys})

	cases := []struct {
		name, method, pattern, path, body, resp string
		want                                    map[string]any
	}{
		{"batch delete", http.MethodDelete, "/api/objects/{bucket}/batch", "/api/objects/b1/batch",
			`{"keys":["a","b","c","d","e","f","g"]}`, `{"deleted":7}`,
			map[string]any{"keyCount": float64(7), "keys": []any{"a", "b", "c", "d", "e"}}},
		{"batch delete over limit", http.MethodDelete, "/api/objects/{bucket}/batch", "/api/objects/b1/batch",
			string(manyKeysBody), `{"deleted":400}`,
			map[string]any{"truncated": true, "keys": []any{"dir/object-0000.bin", "dir/object-0001.bin", "dir/object-0002.bin", "dir/object-0003.bin", "dir/object-0004.bin"}}},
		{"purge blocks", http.MethodPost, "/api/blocks/purge", "/api/blocks/purge",
			`["h1","h2"]`, `{"success":{},"error":{}}`,
			map[string]any{"hashCount": float64(2), "hashes": []any{"h1", "h2"}}},
		{"layout apply", http.MethodPost, "/api/cluster/layout/apply", "/api/cluster/layout/apply",
			`{"version":12}`, `{}`, map[string]any{"version": float64(12)}},
		{"layout revert", http.MethodPost, "/api/cluster/layout/revert", "/api/cluster/layout/revert",
			`{"version":13}`, `{}`, map[string]any{"version": float64(13)}},
		{"cleanup uploads", http.MethodPost, "/api/buckets/{id}/cleanup-uploads", "/api/buckets/b1/cleanup-uploads",
			`{"olderThanSecs":86400}`, `{"uploadsDeleted":3}`, map[string]any{"olderThanSecs": float64(86400)}},
		{"set key perms", http.MethodPut, "/api/buckets/{id}/keys/{kid}", "/api/buckets/b1/keys/GK1",
			`{"read":true,"write":false,"owner":true}`, `{}`,
			map[string]any{"read": true, "write": false, "owner": true}},
		{"console access", http.MethodPost, "/api/buckets/{id}/console-access", "/api/buckets/b1/console-access",
			``, `{"bucketId":"b1","accessKeyId":"GKconsole","permissions":{"read":true,"write":true,"owner":false},"changed":true}`,
			map[string]any{"read": true, "write": true, "owner": false, "changed": true}},
		{"snapshot all nodes", http.MethodPost, "/api/nodes/{id}/snapshot", "/api/nodes/abc/snapshot",
			`{"allNodes":true}`, `{"success":{},"error":{}}`, map[string]any{"allNodes": true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			buf := captureLogs(t)
			var received string
			router := newStubAuditRouter(tc.method, tc.pattern, tc.resp, &received)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body)))

			if received != tc.body {
				t.Errorf("downstream body differs (len %d, want %d)", len(received), len(tc.body))
			}
			audits := logLines(t, buf, "audit")
			if len(audits) != 1 {
				t.Fatalf("want 1 audit line:\n%s", buf.String())
			}
			detail, _ := audits[0]["detail"].(map[string]any)
			for k, v := range tc.want {
				if !reflect.DeepEqual(detail[k], v) {
					t.Errorf("detail[%s] = %#v, want %#v (detail %v)", k, detail[k], v, detail)
				}
			}
			if tc.name == "batch delete over limit" {
				n, _ := detail["keyCountAtLeast"].(float64)
				if n < 5 || n >= 400 {
					t.Errorf("keyCountAtLeast = %v", detail["keyCountAtLeast"])
				}
				if _, ok := detail["keyCount"]; ok {
					t.Errorf("keyCount must be omitted for a truncated body: %v", detail)
				}
			} else if len(detail) != len(tc.want) {
				t.Errorf("detail = %v, want exactly %v", detail, tc.want)
			}
		})
	}
}

func TestAudit_GarageErrorsFlag(t *testing.T) {
	cases := []struct {
		resp string
		want bool
	}{
		{`{"success":{},"error":{"n1":"repair failed"}}`, true},
		{`{"success":{"n1":null},"error":{}}`, false},
		{`{"error":"not a multiresponse"}`, false},
	}
	for _, tc := range cases {
		buf := captureLogs(t)
		var received string
		router := newStubAuditRouter(http.MethodPost, "/api/repair", tc.resp, &received)
		router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/repair", strings.NewReader(`{"repairType":"tables"}`)))
		audits := logLines(t, buf, "audit")
		if len(audits) != 1 {
			t.Fatalf("want 1 audit line:\n%s", buf.String())
		}
		got, _ := audits[0]["garageErrors"].(bool)
		if got != tc.want {
			t.Errorf("resp %s: garageErrors = %v, want %v", tc.resp, audits[0]["garageErrors"], tc.want)
		}
	}
}

func TestAudit_PanickingHandlerIsLogged(t *testing.T) {
	panicky := func(w http.ResponseWriter, r *http.Request) { panic("boom") }

	t.Run("with Recoverer", func(t *testing.T) {
		buf := captureLogs(t)
		r := chi.NewRouter()
		r.Use(accessLog)
		r.Use(middleware.Recoverer)
		r.Post("/api/repair", panicky)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/repair", strings.NewReader(`{"repairType":"blockRc"}`)))

		for _, msg := range []string{"request", "audit"} {
			lines := logLines(t, buf, msg)
			if len(lines) != 1 || lines[0]["status"] != float64(http.StatusInternalServerError) {
				t.Errorf("%s lines = %v, want one with status 500\n%s", msg, lines, buf.String())
			}
		}
		audit := logLines(t, buf, "audit")
		if len(audit) == 1 {
			detail, _ := audit[0]["detail"].(map[string]any)
			if detail["repairType"] != "blockRc" {
				t.Errorf("detail = %v", audit[0]["detail"])
			}
		}
	})

	t.Run("escaping panic", func(t *testing.T) {
		buf := captureLogs(t)
		h := accessLog(http.HandlerFunc(panicky))
		func() {
			defer func() { _ = recover() }()
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodDelete, "/api/buckets/x", nil))
		}()
		for _, msg := range []string{"request", "audit"} {
			lines := logLines(t, buf, msg)
			if len(lines) != 1 || lines[0]["status"] != float64(http.StatusInternalServerError) || lines[0]["panic"] != true {
				t.Errorf("%s lines = %v, want one with status 500 and panic\n%s", msg, lines, buf.String())
			}
		}
	})

	t.Run("newRouter order", func(t *testing.T) {
		// Guard against accessLog moving back inside Recoverer: a nil S3
		// client makes the object handlers panic in the test router.
		var got string
		garage := newAuditGarage(t, &got)
		router, store := setupTestRouter(t, garage.URL)
		buf := captureLogs(t)
		req := authenticatedRequest(t, store, http.MethodDelete, "/api/objects/b1/batch", strings.NewReader(`{"keys":["k"]}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		audits := logLines(t, buf, "audit")
		if len(audits) != 1 || audits[0]["user"] != "testuser" || audits[0]["status"] != float64(rec.Code) {
			t.Fatalf("want 1 audit line for testuser with status %d:\n%s", rec.Code, buf.String())
		}
	})
}

func TestAudit_QueryAllowlist(t *testing.T) {
	buf := captureLogs(t)
	var received string
	router := newStubAuditRouter(http.MethodDelete, "/api/buckets/{id}/aliases/{alias}", `{}`, &received)
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodDelete,
		"/api/buckets/b1/aliases/al?accessKeyId=GK1&token=t0k&continuation-token=ct&code=cd&state=st&overwrite=false", nil))
	audits := logLines(t, buf, "audit")
	if len(audits) != 1 {
		t.Fatalf("want 1 audit line:\n%s", buf.String())
	}
	q, _ := audits[0]["query"].(map[string]any)
	want := map[string]any{"accessKeyId": "GK1", "overwrite": "false"}
	if !reflect.DeepEqual(q, want) {
		t.Errorf("query = %v, want %v", q, want)
	}
}

func TestTruncateUTF8(t *testing.T) {
	long := strings.Repeat("あ", 100) // 300 bytes
	got := truncateUTF8(long, auditMaxValueBytes)
	if !utf8.ValidString(got) || len(got) != 255 {
		t.Errorf("truncateUTF8 = %d bytes, valid %v", len(got), utf8.ValidString(got))
	}
	if truncateUTF8("short", 10) != "short" {
		t.Errorf("short string changed")
	}

	// Through the middleware: a long Japanese object key in the query.
	buf := captureLogs(t)
	var received string
	router := newStubAuditRouter(http.MethodDelete, "/api/objects/{bucket}", `{}`, &received)
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodDelete,
		"/api/objects/b1?key="+url.QueryEscape("x"+long), nil))
	audits := logLines(t, buf, "audit")
	if len(audits) != 1 {
		t.Fatalf("want 1 audit line:\n%s", buf.String())
	}
	q, _ := audits[0]["query"].(map[string]any)
	key, _ := q["key"].(string)
	if !utf8.ValidString(key) || !strings.HasPrefix(key, "xあ") || len(key) > auditMaxValueBytes {
		t.Errorf("logged key = %q (%d bytes)", key, len(key))
	}
	if strings.Contains(buf.String(), `\ufffd`) || strings.ContainsRune(buf.String(), utf8.RuneError) {
		t.Errorf("log contains replacement characters:\n%s", buf.String())
	}
}
