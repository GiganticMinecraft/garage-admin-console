package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

// newFakeBucketGarage serves UpdateBucket and CleanupIncompleteUploads,
// recording every call. A request whose body contains "fail" gets a Garage
// style 400 error.
func newFakeBucketGarage(t *testing.T) (*httptest.Server, func() []upstreamCall) {
	t.Helper()
	var mu sync.Mutex
	var calls []upstreamCall
	record := func(r *http.Request) string {
		body, _ := readAll(r)
		mu.Lock()
		calls = append(calls, upstreamCall{r.Method, r.URL.Path, r.URL.Query().Get("id"), body})
		mu.Unlock()
		return body
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/UpdateBucket", func(w http.ResponseWriter, r *http.Request) {
		body := record(r)
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(body, "fail") {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"code":"InvalidRequest","message":"Bad request: Invalid lifecycle configuration"}`))
			return
		}
		w.Write([]byte(`{"id":"` + r.URL.Query().Get("id") + `"}`))
	})
	mux.HandleFunc("/v2/CleanupIncompleteUploads", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"uploadsDeleted":3}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, func() []upstreamCall {
		mu.Lock()
		defer mu.Unlock()
		return append([]upstreamCall(nil), calls...)
	}
}

func TestUpdateBucketForwardsSettingsUnchanged(t *testing.T) {
	garage, calls := newFakeBucketGarage(t)
	c := newNodeTestClient(t, garage.URL)

	bucketInfoCache.put("stale", garageBucketInfo{})
	body := `{"websiteAccess":{"enabled":true,"indexDocument":"index.html","errorDocument":null,"routingRules":[{"Condition":{"KeyPrefixEquals":"a/"},"Redirect":{"ReplaceKeyPrefixWith":"b/"}}]},` +
		`"quotas":{"maxSize":1073741824,"maxObjects":null},` +
		`"corsRules":[],` +
		`"lifecycleRules":[{"Status":"Enabled","AbortIncompleteMultipartUpload":{"DaysAfterInitiation":3}}]}`
	rec := c.do(http.MethodPut, "/api/buckets/b1", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	got := calls()
	if len(got) != 1 || got[0].method != http.MethodPost || got[0].path != "/v2/UpdateBucket" || got[0].node != "b1" {
		t.Fatalf("upstream = %+v", got)
	}
	if got[0].body != body {
		t.Errorf("upstream body = %s, want it unchanged: %s", got[0].body, body)
	}
	if _, ok := bucketInfoCache.get("stale"); ok {
		t.Error("list caches were not invalidated after a successful update")
	}
}

func TestUpdateBucketForwardsGarageError(t *testing.T) {
	garage, _ := newFakeBucketGarage(t)
	c := newNodeTestClient(t, garage.URL)

	bucketInfoCache.put("kept", garageBucketInfo{})
	t.Cleanup(func() { bucketInfoCache.clear() })
	rec := c.do(http.MethodPut, "/api/buckets/b1", `{"lifecycleRules":[{"Status":"fail"}]}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Invalid lifecycle configuration") {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if _, ok := bucketInfoCache.get("kept"); !ok {
		t.Error("list caches were cleared although Garage rejected the update")
	}
}

func TestCleanupIncompleteUploadsInjectsBucketID(t *testing.T) {
	garage, calls := newFakeBucketGarage(t)
	c := newNodeTestClient(t, garage.URL)

	rec := c.do(http.MethodPost, "/api/buckets/"+url.PathEscape("abc123")+"/cleanup-uploads", `{"olderThanSecs":86400,"bucketId":"other"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"uploadsDeleted":3`) {
		t.Errorf("body = %s", rec.Body.String())
	}
	got := calls()
	if len(got) != 1 || got[0].method != http.MethodPost || got[0].path != "/v2/CleanupIncompleteUploads" {
		t.Fatalf("upstream = %+v", got)
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(got[0].body), &sent); err != nil {
		t.Fatal(err)
	}
	if sent["bucketId"] != "abc123" || sent["olderThanSecs"] != float64(86400) || len(sent) != 2 {
		t.Errorf("upstream body = %v", sent)
	}
}

func TestCleanupIncompleteUploadsRejectsInvalidBody(t *testing.T) {
	garage, calls := newFakeBucketGarage(t)
	c := newNodeTestClient(t, garage.URL)

	for _, body := range []string{
		``,
		`{}`,
		`{"olderThanSecs":null}`,
		`{"olderThanSecs":-1}`,
		`{"olderThanSecs":1.5}`,
		`{"olderThanSecs":"3600"}`,
		`{"olderThanSecs":` + strings.Repeat("9", 5000) + `}`,
	} {
		rec := c.do(http.MethodPost, "/api/buckets/b1/cleanup-uploads", body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %.40q: status = %d, want 400", body, rec.Code)
			continue
		}
		var parsed struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil || parsed.Error == "" {
			t.Errorf("body %.40q: response = %s, want JSON {error}", body, rec.Body.String())
		}
	}
	if n := len(calls()); n != 0 {
		t.Errorf("invalid requests reached Garage %d times", n)
	}
}

// TestBucketSettingsIntegration exercises UpdateBucket and
// CleanupIncompleteUploads against a real Garage when GARAGE_TEST_ADMIN_ENDPOINT
// and GARAGE_TEST_ADMIN_TOKEN are set. It creates and deletes its own bucket.
func TestBucketSettingsIntegration(t *testing.T) {
	endpoint := os.Getenv("GARAGE_TEST_ADMIN_ENDPOINT")
	token := os.Getenv("GARAGE_TEST_ADMIN_TOKEN")
	if endpoint == "" || token == "" {
		t.Skip("GARAGE_TEST_ADMIN_ENDPOINT / GARAGE_TEST_ADMIN_TOKEN not set")
	}
	admin := &GarageAdminClient{baseURL: endpoint, token: token, httpClient: &http.Client{Timeout: 10 * time.Second}}
	r := chi.NewRouter()
	r.Post("/api/buckets", handleCreateBucket(admin))
	r.Put("/api/buckets/{id}", handleUpdateBucket(admin))
	r.Delete("/api/buckets/{id}", handleDeleteBucket(admin))
	r.Post("/api/buckets/{id}/cleanup-uploads", handleCleanupIncompleteUploads(admin))
	do := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	rec := do(http.MethodPost, "/api/buckets", `{"globalAlias":"i376-settings-it"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.ID == "" {
		t.Fatalf("create: %s", rec.Body.String())
	}
	t.Cleanup(func() { do(http.MethodDelete, "/api/buckets/"+created.ID, "") })

	type info struct {
		WebsiteAccess bool `json:"websiteAccess"`
		WebsiteConfig *struct {
			IndexDocument string  `json:"indexDocument"`
			ErrorDocument *string `json:"errorDocument"`
			RoutingRules  []any   `json:"routingRules"`
		} `json:"websiteConfig"`
		CorsRules      []any `json:"corsRules"`
		LifecycleRules []any `json:"lifecycleRules"`
		Quotas         struct {
			MaxSize    *int64 `json:"maxSize"`
			MaxObjects *int64 `json:"maxObjects"`
		} `json:"quotas"`
		UnfinishedMultipartUploads int64 `json:"unfinishedMultipartUploads"`
	}
	update := func(body string) info {
		t.Helper()
		rec := do(http.MethodPut, "/api/buckets/"+created.ID, body)
		if rec.Code != http.StatusOK {
			t.Fatalf("update %s: %d %s", body, rec.Code, rec.Body.String())
		}
		var got info
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got
	}

	got := update(`{"quotas":{"maxSize":1048576,"maxObjects":null},` +
		`"websiteAccess":{"enabled":true,"indexDocument":"index.html","errorDocument":null,"routingRules":[{"Condition":{"KeyPrefixEquals":"a/"},"Redirect":{"ReplaceKeyPrefixWith":"b/"}}]},` +
		`"corsRules":[{"AllowedOrigin":["*"],"AllowedMethod":["GET"]}],` +
		`"lifecycleRules":[{"Status":"Enabled","AbortIncompleteMultipartUpload":{"DaysAfterInitiation":3}}]}`)
	if got.Quotas.MaxSize == nil || *got.Quotas.MaxSize != 1048576 || got.Quotas.MaxObjects != nil {
		t.Errorf("quotas = %+v", got.Quotas)
	}
	if !got.WebsiteAccess || got.WebsiteConfig == nil || got.WebsiteConfig.IndexDocument != "index.html" ||
		got.WebsiteConfig.ErrorDocument != nil || len(got.WebsiteConfig.RoutingRules) != 1 {
		t.Errorf("website = %v %+v", got.WebsiteAccess, got.WebsiteConfig)
	}
	if len(got.CorsRules) != 1 || len(got.LifecycleRules) != 1 {
		t.Errorf("cors = %v lifecycle = %v", got.CorsRules, got.LifecycleRules)
	}

	// Omitted fields are kept; [] deletes; disabling website drops its config.
	got = update(`{"corsRules":[],"websiteAccess":{"enabled":false}}`)
	if got.WebsiteAccess || got.WebsiteConfig != nil || len(got.CorsRules) != 0 || len(got.LifecycleRules) != 1 {
		t.Errorf("after delete: %+v", got)
	}

	rec = do(http.MethodPut, "/api/buckets/"+created.ID, `{"lifecycleRules":[{"Status":"Bogus"}]}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "lifecycle") {
		t.Errorf("invalid lifecycle: %d %s", rec.Code, rec.Body.String())
	}

	rec = do(http.MethodPost, "/api/buckets/"+created.ID+"/cleanup-uploads", `{"olderThanSecs":3600}`)
	var cleaned struct {
		UploadsDeleted *int64 `json:"uploadsDeleted"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &cleaned); rec.Code != http.StatusOK || err != nil || cleaned.UploadsDeleted == nil {
		t.Errorf("cleanup: %d %s", rec.Code, rec.Body.String())
	}
}
