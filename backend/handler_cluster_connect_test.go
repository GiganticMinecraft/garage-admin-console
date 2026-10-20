package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	peerA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@10.0.0.1:3901"
	peerB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@[fd00::2]:3901"
)

func postConnect(t *testing.T, handler http.Handler, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestConnectNodesRejectsInvalidInput(t *testing.T) {
	called := false
	garage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer garage.Close()
	handler, store := setupTestRouter(t, garage.URL)

	eleven := make([]string, 11)
	for i := range eleven {
		eleven[i] = `"` + peerA + `"`
	}
	for _, tc := range []struct{ name, body, want string }{
		{"not json", `nodes`, "invalid JSON"},
		{"missing nodes", `{}`, "at least one"},
		{"empty", `{"nodes":[]}`, "at least one"},
		{"too many", `{"nodes":[` + strings.Join(eleven, ",") + `]}`, "at most 10"},
		{"short id", `{"nodes":["abcd@10.0.0.1:3901"]}`, "nodes[0]"},
		{"uppercase id", `{"nodes":["` + strings.ToUpper(peerA[:64]) + `@10.0.0.1:3901"]}`, "nodes[0]"},
		{"no port", `{"nodes":["` + peerA[:64] + `@10.0.0.1"]}`, "nodes[0]"},
		{"whitespace", `{"nodes":["` + peerA + `","` + peerA[:64] + `@host name:3901"]}`, "nodes[1]"},
		{"no address", `{"nodes":["` + peerA[:64] + `"]}`, "nodes[0]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := authenticatedRequest(t, store, http.MethodPost, "/api/cluster/connect", strings.NewReader(tc.body))
			rec := postConnect(t, handler, req)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), tc.want) {
				t.Fatalf("status = %d body = %s, want 400 containing %q", rec.Code, rec.Body.String(), tc.want)
			}
		})
	}
	if called {
		t.Fatal("invalid input reached Garage")
	}
}

func TestConnectNodesReturnsPerPeerResultsInOrder(t *testing.T) {
	var gotBody string
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/ConnectClusterNodes", func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = readAll(r)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"success":true,"error":null},{"success":false,"error":"Connection refused (os error 111)"}]`))
	})
	garage := httptest.NewServer(mux)
	defer garage.Close()
	handler, store := setupTestRouter(t, garage.URL)

	body := fmt.Sprintf(`{"nodes":[%q,%q]}`, peerA, peerB)
	rec := postConnect(t, handler, authenticatedRequest(t, store, http.MethodPost, "/api/cluster/connect", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if want := fmt.Sprintf(`[%q,%q]`, peerA, peerB); gotBody != want {
		t.Errorf("upstream body = %s, want %s", gotBody, want)
	}
	want := `[{"success":true,"error":null},{"success":false,"error":"Connection refused (os error 111)"}]`
	if strings.TrimSpace(rec.Body.String()) != want {
		t.Errorf("body = %s, want %s", rec.Body.String(), want)
	}
}

func TestConnectNodesUpstreamProblems(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     int
		upstream   string
		wantStatus int
		wantBody   string
	}{
		{"length mismatch", http.StatusOK, `[{"success":true,"error":null}]`, http.StatusBadGateway, "does not match"},
		{"not an array", http.StatusOK, `{"success":true}`, http.StatusBadGateway, "cannot decode"},
		{"garage error forwarded", http.StatusInternalServerError, `{"code":"InternalError","message":"boom"}`, http.StatusInternalServerError, "boom"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			garage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.upstream))
			}))
			defer garage.Close()
			handler, store := setupTestRouter(t, garage.URL)
			body := fmt.Sprintf(`{"nodes":[%q,%q]}`, peerA, peerB)
			rec := postConnect(t, handler, authenticatedRequest(t, store, http.MethodPost, "/api/cluster/connect", strings.NewReader(body)))
			if rec.Code != tc.wantStatus || !strings.Contains(rec.Body.String(), tc.wantBody) {
				t.Fatalf("status = %d body = %s, want %d containing %q", rec.Code, rec.Body.String(), tc.wantStatus, tc.wantBody)
			}
		})
	}
}

func TestConnectNodesRequiresCSRFHeader(t *testing.T) {
	called := false
	garage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer garage.Close()
	handler, store := setupTestRouter(t, garage.URL)
	req := authenticatedRequest(t, store, http.MethodPost, "/api/cluster/connect", strings.NewReader(fmt.Sprintf(`{"nodes":[%q]}`, peerA)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code == http.StatusOK || called {
		t.Fatalf("connect without X-Requested-With reached Garage: status = %d", rec.Code)
	}
}
