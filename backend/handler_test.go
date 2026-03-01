package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/sessions"
	"golang.org/x/oauth2"
)

// newTestGarageServer creates a mock Garage Admin API server.
func newTestGarageServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/v2/GetClusterHealth", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"healthy","knownNodes":3}`))
	})

	mux.HandleFunc("/v2/GetClusterStatus", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"node":"abc123","garageVersion":"1.0"}`))
	})

	mux.HandleFunc("/v2/GetClusterLayout", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"version":1,"roles":[]}`))
	})

	mux.HandleFunc("/v2/ApplyClusterLayout", func(w http.ResponseWriter, r *http.Request) {
		var parsed json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&parsed)
		resp, _ := json.Marshal(map[string]interface{}{
			"applied": true,
			"body":    parsed,
		})
		w.Header().Set("Content-Type", "application/json")
		w.Write(resp)
	})

	mux.HandleFunc("/v2/ListBuckets", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"id":"bucket1"},{"id":"bucket2"}]`))
	})

	mux.HandleFunc("/v2/GetBucketInfo", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"` + id + `"}`))
	})

	mux.HandleFunc("/v2/CreateBucket", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"new-bucket"}`))
	})

	mux.HandleFunc("/v2/DeleteBucket", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("/v2/ListKeys", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"accessKeyId":"key1"}]`))
	})

	mux.HandleFunc("/v2/GetKeyInfo", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"accessKeyId":"` + id + `"}`))
	})

	mux.HandleFunc("/v2/ListWorkers", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success":{"node1":[{"name":"repair","state":"idle"}]},"error":{}}`))
	})

	return httptest.NewServer(mux)
}

// setupTestRouter creates a router with mock dependencies and an authenticated session.
func setupTestRouter(t *testing.T, garageURL string) (http.Handler, *sessions.CookieStore) {
	t.Helper()

	store := sessions.NewCookieStore([]byte("test-secret-that-is-at-least-32b"), []byte("test-secret-that-is-at-least-32b"))
	store.Options = &sessions.Options{
		Path:     "/",
		MaxAge:   3600,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	}
	sessionStore = store

	garageAdmin := &GarageAdminClient{
		baseURL:    garageURL,
		token:      "test-token",
		httpClient: http.DefaultClient,
	}

	// Initialise oauthConfig so handleLogin works without panic.
	oauthConfig = &oauth2.Config{
		ClientID:     "test-client-id",
		ClientSecret: "test-client-secret",
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://github.com/login/oauth/authorize",
			TokenURL: "https://github.com/login/oauth/access_token",
		},
		RedirectURL: "http://localhost:8080/api/auth/callback",
		Scopes:      []string{"read:org"},
	}

	// S3Client is nil — object endpoints won't work in these tests,
	// but we test routing and middleware behavior for non-S3 endpoints.
	r := newRouter(garageAdmin, nil)
	return r, store
}

// authenticatedRequest creates an HTTP request with a valid session cookie.
func authenticatedRequest(t *testing.T, store *sessions.CookieStore, method, path string, body io.Reader) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, path, body)

	// Create a session and encode it into a cookie.
	sess, _ := store.New(req, sessionName)
	sess.Values[sessionKeyUser] = "testuser"
	sess.Values[sessionKeyAvatar] = "https://example.com/avatar.png"

	recorder := httptest.NewRecorder()
	sess.Save(req, recorder)

	// Extract Set-Cookie from recorder and add to request.
	for _, cookie := range recorder.Result().Cookies() {
		req.AddCookie(cookie)
	}
	return req
}

func TestHealthEndpoint(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, _ := setupTestRouter(t, gs.URL)

	req := httptest.NewRequest("GET", "/api/health", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected Content-Type application/json, got %q", ct)
	}
	if body := rr.Body.String(); !strings.Contains(body, `"status":"ok"`) {
		t.Errorf("unexpected body: %s", body)
	}
}

func TestUnauthenticatedRequestReturns401(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, _ := setupTestRouter(t, gs.URL)

	paths := []string{
		"/api/cluster/health",
		"/api/cluster/status",
		"/api/buckets",
		"/api/keys",
		"/api/workers",
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest("GET", path, nil)
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusUnauthorized {
				t.Errorf("expected 401 for %s, got %d", path, rr.Code)
			}
		})
	}
}

func TestAuthEndpointsAccessibleWithoutAuth(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, _ := setupTestRouter(t, gs.URL)

	// /api/auth/login should redirect (302) to GitHub OAuth, not 401.
	req := httptest.NewRequest("GET", "/api/auth/login", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusFound {
		t.Errorf("/api/auth/login expected 302 redirect, got %d", rr.Code)
	}
	loc := rr.Header().Get("Location")
	if !strings.Contains(loc, "github.com") {
		t.Errorf("expected redirect to GitHub, got Location: %s", loc)
	}
}

func TestClusterProxyForwardsContentType(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, store := setupTestRouter(t, gs.URL)

	req := authenticatedRequest(t, store, "GET", "/api/cluster/health", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected upstream Content-Type, got %q", ct)
	}
	if body := rr.Body.String(); !strings.Contains(body, "knownNodes") {
		t.Errorf("expected proxied response, got: %s", body)
	}
}

func TestClusterStatusProxy(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, store := setupTestRouter(t, gs.URL)

	req := authenticatedRequest(t, store, "GET", "/api/cluster/status", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
	if body := rr.Body.String(); !strings.Contains(body, "garageVersion") {
		t.Errorf("expected proxied status response, got: %s", body)
	}
}

func TestBucketListProxy(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, store := setupTestRouter(t, gs.URL)

	req := authenticatedRequest(t, store, "GET", "/api/buckets", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
	if body := rr.Body.String(); !strings.Contains(body, "bucket1") {
		t.Errorf("expected bucket list, got: %s", body)
	}
}

func TestBucketGetByID(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, store := setupTestRouter(t, gs.URL)

	req := authenticatedRequest(t, store, "GET", "/api/buckets/test-bucket-id", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
	if body := rr.Body.String(); !strings.Contains(body, "test-bucket-id") {
		t.Errorf("expected bucket with id, got: %s", body)
	}
}

func TestKeyListProxy(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, store := setupTestRouter(t, gs.URL)

	req := authenticatedRequest(t, store, "GET", "/api/keys", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
	if body := rr.Body.String(); !strings.Contains(body, "key1") {
		t.Errorf("expected key list, got: %s", body)
	}
}

func TestWorkerListProxy(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, store := setupTestRouter(t, gs.URL)

	req := authenticatedRequest(t, store, "GET", "/api/workers", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
	if body := rr.Body.String(); !strings.Contains(body, "repair") {
		t.Errorf("expected worker list, got: %s", body)
	}
}

func TestCSRFMiddlewareRequiresXRequestedWith(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, store := setupTestRouter(t, gs.URL)

	// POST without X-Requested-With should be 403.
	req := authenticatedRequest(t, store, "POST", "/api/buckets", strings.NewReader(`{"name":"test"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403 without X-Requested-With, got %d", rr.Code)
	}
}

func TestCSRFMiddlewareAllowsValidRequest(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, store := setupTestRouter(t, gs.URL)

	// POST with both headers should succeed.
	req := authenticatedRequest(t, store, "POST", "/api/buckets", strings.NewReader(`{"name":"test"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code == http.StatusForbidden {
		t.Errorf("expected non-403 with valid CSRF headers, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestDeleteWithoutBodyDoesNotRequireContentType(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, store := setupTestRouter(t, gs.URL)

	// DELETE without body and without Content-Type should work (only X-Requested-With needed).
	req := authenticatedRequest(t, store, "DELETE", "/api/buckets/test-id", nil)
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.ContentLength = 0
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code == http.StatusForbidden {
		t.Errorf("DELETE without body should not require Content-Type, got 403: %s", rr.Body.String())
	}
}

func TestLayoutPostProxy(t *testing.T) {
	gs := newTestGarageServer(t)
	defer gs.Close()

	handler, store := setupTestRouter(t, gs.URL)

	body := `{"version":1}`
	req := authenticatedRequest(t, store, "POST", "/api/cluster/layout", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if respBody := rr.Body.String(); !strings.Contains(respBody, "applied") {
		t.Errorf("expected proxied POST response, got: %s", respBody)
	}
}
