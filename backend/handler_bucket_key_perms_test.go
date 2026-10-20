package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

const (
	testBucketID = "d62d70c75d58aa81217977f71590d960b707bedf8878058f989b07b396646aec"
	testKeyID    = "GK243a9964af89bbb4a0ff23ce"
)

// fakePermGarage is a stateful fake of GetBucketInfo / AllowBucketKey /
// DenyBucketKey for one bucket, recording the mutation calls it receives.
type fakePermGarage struct {
	mu    sync.Mutex
	perms map[string]bucketKeyPerm
	calls []upstreamCall
	// failPath, when set, makes that endpoint answer failStatus.
	failPath   string
	failStatus int
}

func (f *fakePermGarage) bucketInfo() []byte {
	type key struct {
		AccessKeyID string        `json:"accessKeyId"`
		Name        string        `json:"name"`
		Permissions bucketKeyPerm `json:"permissions"`
	}
	keys := []key{}
	for id, p := range f.perms {
		keys = append(keys, key{id, "name-" + id, p})
	}
	b, _ := json.Marshal(map[string]any{"id": testBucketID, "globalAliases": []string{"backups"}, "keys": keys})
	return b
}

func (f *fakePermGarage) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	fail := func(w http.ResponseWriter, path string) bool {
		if f.failPath == path {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(f.failStatus)
			w.Write([]byte(`{"code":"NoSuchAccessKey","message":"Access key not found: GKbad"}`))
			return true
		}
		return false
	}
	mux.HandleFunc("/v2/GetBucketInfo", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if fail(w, r.URL.Path) {
			return
		}
		if r.URL.Query().Get("id") != testBucketID {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"code":"NoSuchBucket","message":"Bucket not found"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(f.bucketInfo())
	})
	change := func(allow bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			body, _ := readAll(r)
			f.mu.Lock()
			defer f.mu.Unlock()
			f.calls = append(f.calls, upstreamCall{method: r.Method, path: r.URL.Path, body: body})
			if fail(w, r.URL.Path) {
				return
			}
			var req struct {
				BucketID    string        `json:"bucketId"`
				AccessKeyID string        `json:"accessKeyId"`
				Permissions bucketKeyPerm `json:"permissions"`
			}
			if err := json.Unmarshal([]byte(body), &req); err != nil || req.BucketID != testBucketID {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			p := f.perms[req.AccessKeyID]
			set := func(dst *bool, flag bool) {
				if flag {
					*dst = allow
				}
			}
			set(&p.Read, req.Permissions.Read)
			set(&p.Write, req.Permissions.Write)
			set(&p.Owner, req.Permissions.Owner)
			f.perms[req.AccessKeyID] = p
			w.Header().Set("Content-Type", "application/json")
			w.Write(f.bucketInfo())
		}
	}
	mux.HandleFunc("/v2/AllowBucketKey", change(true))
	mux.HandleFunc("/v2/DenyBucketKey", change(false))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func (f *fakePermGarage) mutations() []upstreamCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]upstreamCall(nil), f.calls...)
}

func decodePermsResponse(t *testing.T, rec *httptest.ResponseRecorder) bucketKeyPermsResponse {
	t.Helper()
	var got bucketKeyPermsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	return got
}

func permsPath(bucket, key string) string {
	return "/api/buckets/" + bucket + "/keys/" + key
}

func TestSetBucketKeyPermissionsSendsDiff(t *testing.T) {
	f := &fakePermGarage{perms: map[string]bucketKeyPerm{testKeyID: {Read: true, Write: true}}}
	c := newNodeTestClient(t, f.server(t).URL)

	rec := c.do(http.MethodPut, permsPath(testBucketID, testKeyID), `{"read":true,"write":false,"owner":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	got := decodePermsResponse(t, rec)
	want := bucketKeyPerm{Read: true, Owner: true}
	if got.Permissions != want || !got.Changed || got.AccessKeyID != testKeyID || got.BucketID != testBucketID {
		t.Errorf("response = %+v, want perms %+v changed", got, want)
	}

	calls := f.mutations()
	if len(calls) != 2 {
		t.Fatalf("calls = %+v, want Allow then Deny", calls)
	}
	if calls[0].path != "/v2/AllowBucketKey" || !strings.Contains(calls[0].body, `"permissions":{"read":false,"write":false,"owner":true}`) {
		t.Errorf("allow call = %+v", calls[0])
	}
	if calls[1].path != "/v2/DenyBucketKey" || !strings.Contains(calls[1].body, `"permissions":{"read":false,"write":true,"owner":false}`) {
		t.Errorf("deny call = %+v", calls[1])
	}
	if calls[0].method != http.MethodPost || calls[1].method != http.MethodPost {
		t.Errorf("mutations must be POST: %+v", calls)
	}
}

func TestGrantBucketKeyInjectsBucketID(t *testing.T) {
	f := &fakePermGarage{perms: map[string]bucketKeyPerm{}}
	c := newNodeTestClient(t, f.server(t).URL)

	rec := c.do(http.MethodPost, "/api/buckets/"+testBucketID+"/keys", `{"accessKeyId":"GKnew","permissions":{"read":true,"write":false,"owner":false}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	calls := f.mutations()
	if len(calls) != 1 || calls[0].path != "/v2/AllowBucketKey" || !strings.Contains(calls[0].body, `"bucketId":"`+testBucketID+`"`) {
		t.Errorf("calls = %+v, want one AllowBucketKey with the bucket id from the URL", calls)
	}
	if f.perms["GKnew"] != (bucketKeyPerm{Read: true}) {
		t.Errorf("perms = %+v", f.perms["GKnew"])
	}
}

func TestSetBucketKeyPermissionsGrantsNewKeyWithAllowOnly(t *testing.T) {
	f := &fakePermGarage{perms: map[string]bucketKeyPerm{}}
	c := newNodeTestClient(t, f.server(t).URL)

	rec := c.do(http.MethodPut, permsPath(testBucketID, "GKnew"), `{"read":true,"write":true,"owner":false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if got := decodePermsResponse(t, rec); got.Permissions != (bucketKeyPerm{Read: true, Write: true}) {
		t.Errorf("perms = %+v", got.Permissions)
	}
	calls := f.mutations()
	if len(calls) != 1 || calls[0].path != "/v2/AllowBucketKey" {
		t.Errorf("calls = %+v, want a single AllowBucketKey", calls)
	}
}

func TestSetBucketKeyPermissionsNoOp(t *testing.T) {
	f := &fakePermGarage{perms: map[string]bucketKeyPerm{testKeyID: {Read: true}}}
	c := newNodeTestClient(t, f.server(t).URL)

	rec := c.do(http.MethodPut, permsPath(testBucketID, testKeyID), `{"read":true,"write":false,"owner":false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	got := decodePermsResponse(t, rec)
	if got.Changed || got.Permissions != (bucketKeyPerm{Read: true}) {
		t.Errorf("response = %+v, want unchanged read-only", got)
	}
	if calls := f.mutations(); len(calls) != 0 {
		t.Errorf("no-op should not mutate, got %+v", calls)
	}
}

func TestSetBucketKeyPermissionsRejectsInvalidBodies(t *testing.T) {
	f := &fakePermGarage{perms: map[string]bucketKeyPerm{testKeyID: {Read: true}}}
	c := newNodeTestClient(t, f.server(t).URL)

	for _, body := range []string{
		`{"read":false,"write":false,"owner":false}`,
		`{}`,
		`not json`,
		`{"read":true,"bucketId":"other"}`,
	} {
		rec := c.do(http.MethodPut, permsPath(testBucketID, testKeyID), body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status = %d, want 400", body, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `"error"`) {
			t.Errorf("body %s: expected JSON error, got %s", body, rec.Body.String())
		}
	}
	if calls := f.mutations(); len(calls) != 0 {
		t.Errorf("invalid bodies must not reach Garage, got %+v", calls)
	}
}

func TestSetBucketKeyPermissionsForwardsGarageErrors(t *testing.T) {
	t.Run("unknown bucket", func(t *testing.T) {
		f := &fakePermGarage{perms: map[string]bucketKeyPerm{}}
		c := newNodeTestClient(t, f.server(t).URL)
		rec := c.do(http.MethodPut, permsPath("nope", testKeyID), `{"read":true}`)
		if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Bucket not found") {
			t.Errorf("status = %d body = %s, want forwarded 404", rec.Code, rec.Body.String())
		}
	})

	t.Run("allow fails", func(t *testing.T) {
		f := &fakePermGarage{
			perms:      map[string]bucketKeyPerm{testKeyID: {Write: true}},
			failPath:   "/v2/AllowBucketKey",
			failStatus: http.StatusBadRequest,
		}
		c := newNodeTestClient(t, f.server(t).URL)
		rec := c.do(http.MethodPut, permsPath(testBucketID, testKeyID), `{"read":true,"write":false,"owner":false}`)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Access key not found") {
			t.Errorf("status = %d body = %s, want forwarded Garage error", rec.Code, rec.Body.String())
		}
		calls := f.mutations()
		if len(calls) != 1 || calls[0].path != "/v2/AllowBucketKey" {
			t.Errorf("Deny must not run after a failed Allow, calls = %+v", calls)
		}
	})
}

// TestBucketKeyPermissionsIntegration exercises CreateKey (expiration +
// createBucket), UpdateKey and the permission diff endpoint against a real
// Garage when GARAGE_TEST_ADMIN_ENDPOINT / GARAGE_TEST_ADMIN_TOKEN are set.
// It creates an i377-* key and bucket and deletes them afterwards.
func TestBucketKeyPermissionsIntegration(t *testing.T) {
	endpoint := os.Getenv("GARAGE_TEST_ADMIN_ENDPOINT")
	if endpoint == "" {
		t.Skip("GARAGE_TEST_ADMIN_ENDPOINT not set")
	}
	client := &GarageAdminClient{baseURL: endpoint, token: os.Getenv("GARAGE_TEST_ADMIN_TOKEN"), httpClient: &http.Client{Timeout: 10 * time.Second}}
	r := chi.NewRouter()
	r.Post("/api/keys", handleCreateKey(client))
	r.Put("/api/keys/{id}", handleUpdateKey(client))
	r.Put("/api/buckets/{id}/keys/{kid}", handleSetBucketKeyPermissions(client))
	do := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
	garage := func(path, body string, out any) {
		t.Helper()
		if err := garageRequestJSON(context.Background(), client, http.MethodPost, path, []byte(body), out); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	// Delete* answer with an empty body, so they bypass garageRequestJSON.
	deleteGarage := func(path string) {
		resp, err := client.doRequest(context.Background(), http.MethodPost, path, nil)
		if err != nil {
			t.Errorf("cleanup %s: %v", path, err)
			return
		}
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			t.Errorf("cleanup %s: status %d", path, resp.StatusCode)
		}
	}
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)

	// CreateKey with an expiration and createBucket, as the create dialog sends it.
	expiration := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second).Format(time.RFC3339)
	rec := do(http.MethodPost, "/api/keys", `{"name":"i377-key-`+suffix+`","expiration":"`+expiration+`","allow":{"createBucket":true}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("CreateKey: %d %s", rec.Code, rec.Body.String())
	}
	var key struct {
		AccessKeyID string  `json:"accessKeyId"`
		Expiration  *string `json:"expiration"`
		Permissions struct {
			CreateBucket bool `json:"createBucket"`
		} `json:"permissions"`
	}
	json.Unmarshal(rec.Body.Bytes(), &key)
	t.Cleanup(func() {
		deleteGarage("/v2/DeleteKey?id=" + key.AccessKeyID)
	})
	if key.Expiration == nil || !key.Permissions.CreateBucket {
		t.Errorf("CreateKey ignored expiration/createBucket: %s", rec.Body.String())
	}

	// UpdateKey: never expires, deny createBucket, rename.
	rec = do(http.MethodPut, "/api/keys/"+key.AccessKeyID, `{"name":"i377-key-renamed-`+suffix+`","neverExpires":true,"deny":{"createBucket":true}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("UpdateKey: %d %s", rec.Code, rec.Body.String())
	}
	json.Unmarshal(rec.Body.Bytes(), &key)
	if key.Expiration != nil || key.Permissions.CreateBucket {
		t.Errorf("UpdateKey not applied: %s", rec.Body.String())
	}

	var bucket struct {
		ID string `json:"id"`
	}
	garage("/v2/CreateBucket", `{"globalAlias":"i377-bucket-`+suffix+`"}`, &bucket)
	t.Cleanup(func() {
		deleteGarage("/v2/DeleteBucket?id=" + bucket.ID)
	})

	path := "/api/buckets/" + bucket.ID + "/keys/" + key.AccessKeyID
	for _, step := range []struct {
		body string
		want bucketKeyPerm
	}{
		{`{"read":true,"write":true,"owner":false}`, bucketKeyPerm{Read: true, Write: true}},
		{`{"read":false,"write":true,"owner":true}`, bucketKeyPerm{Write: true, Owner: true}},
		{`{"read":false,"write":true,"owner":true}`, bucketKeyPerm{Write: true, Owner: true}},
	} {
		rec := do(http.MethodPut, path, step.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("PUT %s: %d %s", step.body, rec.Code, rec.Body.String())
		}
		if got := decodePermsResponse(t, rec); got.Permissions != step.want {
			t.Errorf("PUT %s: perms = %+v, want %+v", step.body, got.Permissions, step.want)
		}
	}
	var info garageBucketKeys
	if err := garageGetJSON(context.Background(), client, "/v2/GetBucketInfo?id="+bucket.ID, &info); err != nil {
		t.Fatal(err)
	}
	if got := info.permsOf(key.AccessKeyID); got != (bucketKeyPerm{Write: true, Owner: true}) {
		t.Errorf("Garage state = %+v", got)
	}
}

func TestS3ConnectionInfo(t *testing.T) {
	for _, tc := range []struct {
		name                     string
		public, internal, region string
		want                     s3ConnectionInfo
	}{
		{
			name:   "public endpoint wins",
			public: "https://s3.example.com", internal: "http://garage:3900", region: "garage",
			want: s3ConnectionInfo{Region: "garage", Endpoint: "https://s3.example.com", PublicEndpoint: true},
		},
		{
			name:     "falls back to GARAGE_S3_ENDPOINT",
			internal: "http://garage:3900",
			want:     s3ConnectionInfo{Region: "seichi-cloud", Endpoint: "http://garage:3900"},
		},
		{
			name: "defaults",
			want: s3ConnectionInfo{Region: "seichi-cloud", Endpoint: "http://garage.garage.svc.cluster.local:3900"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("GARAGE_S3_PUBLIC_ENDPOINT", tc.public)
			t.Setenv("GARAGE_S3_ENDPOINT", tc.internal)
			t.Setenv("GARAGE_S3_REGION", tc.region)
			t.Setenv("GARAGE_S3_ACCESS_KEY", "")

			// The router reads the environment when it is built.
			c := newNodeTestClient(t, "http://127.0.0.1:1")
			rec := c.do(http.MethodGet, "/api/s3/connection", "")
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
			}
			var got s3ConnectionInfo
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if got != tc.want {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}
