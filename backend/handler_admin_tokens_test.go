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
)

const testAdminTokenID = "b3e4aaf8a5574962ea09caa6"

// adminTokenCall records one request received by the fake Garage.
type adminTokenCall struct {
	method, path, id, body, auth string
}

// newFakeAdminTokenGarage serves Garage's admin token endpoints with canned
// answers shaped like Garage v2.4.1's and records every call.
func newFakeAdminTokenGarage(t *testing.T) (*httptest.Server, func() []adminTokenCall) {
	t.Helper()
	var mu sync.Mutex
	var calls []adminTokenCall
	info := `{"id":"` + testAdminTokenID + `","created":"2026-10-19T05:48:38.562Z","name":"backup","expiration":null,"expired":false,"scope":["GetClusterStatus","ListBuckets"]}`
	mux := http.NewServeMux()
	handle := func(path string, status int, payload string) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			body, _ := readAll(r)
			mu.Lock()
			calls = append(calls, adminTokenCall{r.Method, r.URL.Path, r.URL.Query().Get("id"), body, r.Header.Get("Authorization")})
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			w.Write([]byte(payload))
		})
	}
	handle("/v2/ListAdminTokens", http.StatusOK, `[{"id":null,"created":null,"name":"admin_token (from daemon configuration)","expiration":null,"expired":false,"scope":["*"]},`+info+`]`)
	handle("/v2/GetCurrentAdminTokenInfo", http.StatusOK, `{"id":null,"created":null,"name":"admin_token (from daemon configuration)","expiration":null,"expired":false,"scope":["*"]}`)
	handle("/v2/GetAdminTokenInfo", http.StatusOK, info)
	handle("/v2/CreateAdminToken", http.StatusOK, `{"secretToken":"`+testAdminTokenID+`.supersecret","id":"`+testAdminTokenID+`","created":"2026-10-19T05:48:38.562Z","name":"backup","expiration":null,"expired":false,"scope":["*"]}`)
	handle("/v2/UpdateAdminToken", http.StatusOK, info)
	handle("/v2/DeleteAdminToken", http.StatusOK, `null`)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, func() []adminTokenCall {
		mu.Lock()
		defer mu.Unlock()
		return append([]adminTokenCall(nil), calls...)
	}
}

func TestAdminTokenRoutesProxyToGarage(t *testing.T) {
	garage, calls := newFakeAdminTokenGarage(t)
	c := newNodeTestClient(t, garage.URL)

	for _, tc := range []struct {
		method, path, body             string
		wantMethod, wantPath, wantID   string
		wantBody, wantResponseContains string
	}{
		{http.MethodGet, "/api/admin-tokens", "", http.MethodGet, "/v2/ListAdminTokens", "", "", `"id":null`},
		{http.MethodGet, "/api/admin-tokens/current", "", http.MethodGet, "/v2/GetCurrentAdminTokenInfo", "", "", `"scope":["*"]`},
		{http.MethodGet, "/api/admin-tokens/" + testAdminTokenID, "", http.MethodGet, "/v2/GetAdminTokenInfo", testAdminTokenID, "", `"name":"backup"`},
		{http.MethodPut, "/api/admin-tokens/" + testAdminTokenID, `{"name":"renamed","neverExpires":true,"scope":["ListBuckets"]}`, http.MethodPost, "/v2/UpdateAdminToken", testAdminTokenID, `{"name":"renamed","neverExpires":true,"scope":["ListBuckets"]}`, `"name":"backup"`},
		{http.MethodDelete, "/api/admin-tokens/" + testAdminTokenID, "", http.MethodPost, "/v2/DeleteAdminToken", testAdminTokenID, "", `null`},
	} {
		rec := c.do(tc.method, tc.path, tc.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s: status = %d body = %s", tc.method, tc.path, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), tc.wantResponseContains) {
			t.Errorf("%s %s: body = %s, want it to contain %s", tc.method, tc.path, rec.Body.String(), tc.wantResponseContains)
		}
		got := calls()
		last := got[len(got)-1]
		if last.method != tc.wantMethod || last.path != tc.wantPath || last.id != tc.wantID || last.body != tc.wantBody {
			t.Errorf("%s %s: upstream = %+v, want %s %s id=%q body=%q", tc.method, tc.path, last, tc.wantMethod, tc.wantPath, tc.wantID, tc.wantBody)
		}
		if last.auth != "Bearer test-token" {
			t.Errorf("%s %s: upstream Authorization = %q", tc.method, tc.path, last.auth)
		}
	}
}

func TestCreateAdminTokenPassesSecretThroughWithNoStore(t *testing.T) {
	garage, calls := newFakeAdminTokenGarage(t)
	c := newNodeTestClient(t, garage.URL)

	reqBody := `{"name":"backup","expiration":"2030-01-01T00:00:00Z","scope":["*"]}`
	rec := c.do(http.MethodPost, "/api/admin-tokens", reqBody)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	var created struct {
		SecretToken string `json:"secretToken"`
		ID          string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.SecretToken != testAdminTokenID+".supersecret" || created.ID != testAdminTokenID {
		t.Errorf("created = %+v", created)
	}
	last := calls()[0]
	if last.method != http.MethodPost || last.path != "/v2/CreateAdminToken" || last.body != reqBody {
		t.Errorf("upstream = %+v", last)
	}
}

func TestCreateAdminTokenNoStoreOnGarageError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/CreateAdminToken", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"code":"InvalidRequest","message":"Bad request: cannot specify ` + "`expiration` and `never_expires`" + `"}`))
	})
	garage := httptest.NewServer(mux)
	t.Cleanup(garage.Close)
	c := newNodeTestClient(t, garage.URL)

	rec := c.do(http.MethodPost, "/api/admin-tokens", `{"neverExpires":true,"expiration":"2030-01-01T00:00:00Z"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "never_expires") {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
}

func TestAdminTokenRoutesRejectInvalidID(t *testing.T) {
	garage, calls := newFakeAdminTokenGarage(t)
	c := newNodeTestClient(t, garage.URL)

	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/admin-tokens/zz", ""},
		{http.MethodGet, "/api/admin-tokens/" + strings.Repeat("a", 65), ""},
		{http.MethodGet, "/api/admin-tokens/abc&id=x", ""},
		{http.MethodPut, "/api/admin-tokens/not-hex", `{"name":"x"}`},
		{http.MethodDelete, "/api/admin-tokens/%2A", ""},
	} {
		rec := c.do(tc.method, tc.path, tc.body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s %s: status = %d, want 400 (body %s)", tc.method, tc.path, rec.Code, rec.Body.String())
			continue
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || !strings.Contains(body["error"], "hex") {
			t.Errorf("%s %s: body = %s", tc.method, tc.path, rec.Body.String())
		}
	}
	if got := calls(); len(got) != 0 {
		t.Errorf("invalid IDs reached Garage: %+v", got)
	}
}

func TestAdminTokenGarageErrorsPassThrough(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/GetAdminTokenInfo", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"code":"NoSuchAdminToken","message":"Admin token not found: abc"}`))
	})
	garage := httptest.NewServer(mux)
	t.Cleanup(garage.Close)
	c := newNodeTestClient(t, garage.URL)

	rec := c.do(http.MethodGet, "/api/admin-tokens/abc", "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "NoSuchAdminToken") {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestAdminTokenOversizedBodyIs413(t *testing.T) {
	garage, calls := newFakeAdminTokenGarage(t)
	c := newNodeTestClient(t, garage.URL)

	big := `{"name":"` + strings.Repeat("a", maxAdminTokenRequestBody) + `"}`
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/admin-tokens"},
		{http.MethodPut, "/api/admin-tokens/" + testAdminTokenID},
	} {
		rec := c.do(tc.method, tc.path, big)
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("%s %s: status = %d, want 413", tc.method, tc.path, rec.Code)
			continue
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || !strings.Contains(body["error"], "too large") {
			t.Errorf("%s %s: body = %s", tc.method, tc.path, rec.Body.String())
		}
	}
	if got := calls(); len(got) != 0 {
		t.Errorf("oversized bodies reached Garage: %d calls", len(got))
	}
}

// TestAdminTokenLifecycleAgainstGarage creates, reads, updates, lists and
// deletes a token against a real Garage when GARAGE_TEST_ADMIN_ENDPOINT and
// GARAGE_TEST_ADMIN_TOKEN are set.
func TestAdminTokenLifecycleAgainstGarage(t *testing.T) {
	endpoint := os.Getenv("GARAGE_TEST_ADMIN_ENDPOINT")
	if endpoint == "" {
		t.Skip("GARAGE_TEST_ADMIN_ENDPOINT not set")
	}
	// setupTestRouter wires a fake token; reuse only its session store and
	// build a router whose client carries the real admin token.
	_, store := setupTestRouter(t, endpoint)
	admin := &GarageAdminClient{baseURL: endpoint, token: os.Getenv("GARAGE_TEST_ADMIN_TOKEN"), httpClient: &http.Client{Timeout: 10 * time.Second}}
	router := newRouter(admin, nil)
	do := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := authenticatedRequest(t, store, method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	name := "i382-token-" + time.Now().UTC().Format("150405.000")
	rec := do(http.MethodPost, "/api/admin-tokens", `{"name":"`+name+`","expiration":"2099-01-01T00:00:00Z","scope":["GetClusterStatus","ListBuckets"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("create: status = %d body = %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("create: Cache-Control = %q", rec.Header().Get("Cache-Control"))
	}
	var created struct {
		SecretToken string   `json:"secretToken"`
		ID          string   `json:"id"`
		Name        string   `json:"name"`
		Expiration  *string  `json:"expiration"`
		Scope       []string `json:"scope"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || !strings.HasPrefix(created.SecretToken, created.ID+".") || created.Name != name || created.Expiration == nil || len(created.Scope) != 2 {
		t.Fatalf("create: unexpected response (id=%q name=%q expiration=%v scope=%v)", created.ID, created.Name, created.Expiration, created.Scope)
	}
	t.Cleanup(func() {
		if rec := do(http.MethodDelete, "/api/admin-tokens/"+created.ID, ""); rec.Code != http.StatusOK && rec.Code != http.StatusNotFound {
			t.Errorf("cleanup delete: status = %d body = %s", rec.Code, rec.Body.String())
		}
	})

	rec = do(http.MethodGet, "/api/admin-tokens/"+created.ID, "")
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "secretToken") {
		t.Fatalf("get: status = %d body = %s", rec.Code, rec.Body.String())
	}

	rec = do(http.MethodPut, "/api/admin-tokens/"+created.ID, `{"name":"`+name+`-renamed","neverExpires":true,"scope":["*"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("update: status = %d body = %s", rec.Code, rec.Body.String())
	}
	var updated struct {
		Name       string   `json:"name"`
		Expiration *string  `json:"expiration"`
		Scope      []string `json:"scope"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Name != name+"-renamed" || updated.Expiration != nil || len(updated.Scope) != 1 || updated.Scope[0] != "*" {
		t.Errorf("update: got %+v", updated)
	}

	rec = do(http.MethodGet, "/api/admin-tokens", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), created.ID) {
		t.Errorf("list: status = %d, token %s missing", rec.Code, created.ID)
	}
	rec = do(http.MethodGet, "/api/admin-tokens/current", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"scope"`) {
		t.Errorf("current: status = %d body = %s", rec.Code, rec.Body.String())
	}

	rec = do(http.MethodDelete, "/api/admin-tokens/"+created.ID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("delete: status = %d body = %s", rec.Code, rec.Body.String())
	}
	rec = do(http.MethodGet, "/api/admin-tokens/"+created.ID, "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("get after delete: status = %d body = %s", rec.Code, rec.Body.String())
	}
}
