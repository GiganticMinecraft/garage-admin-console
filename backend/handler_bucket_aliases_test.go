package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

// newFakeAliasGarage answers AddBucketAlias / RemoveBucketAlias with a canned
// GetBucketInfo body (or failBody/failStatus when set) and records the calls.
func newFakeAliasGarage(t *testing.T, failStatus int, failBody string) (*httptest.Server, func() []upstreamCall) {
	t.Helper()
	var mu sync.Mutex
	var calls []upstreamCall
	mux := http.NewServeMux()
	for _, p := range []string{"/v2/AddBucketAlias", "/v2/RemoveBucketAlias"} {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			body, _ := readAll(r)
			mu.Lock()
			calls = append(calls, upstreamCall{method: r.Method, path: r.URL.Path, body: body})
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			if failStatus != 0 {
				w.WriteHeader(failStatus)
				w.Write([]byte(failBody))
				return
			}
			w.Write([]byte(`{"id":"` + testBucketID + `","globalAliases":["backups","extra"],"keys":[]}`))
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, func() []upstreamCall {
		mu.Lock()
		defer mu.Unlock()
		return append([]upstreamCall(nil), calls...)
	}
}

func aliasesPath() string { return "/api/buckets/" + testBucketID + "/aliases" }

func TestBucketAliasForwardsToGarage(t *testing.T) {
	for _, tc := range []struct {
		name, method, body, wantPath string
		want                         map[string]string
	}{
		{"add global", http.MethodPost, `{"globalAlias":"extra"}`, "/v2/AddBucketAlias",
			map[string]string{"bucketId": testBucketID, "globalAlias": "extra"}},
		{"add local", http.MethodPost, `{"localAlias":"mine","accessKeyId":"` + testKeyID + `"}`, "/v2/AddBucketAlias",
			map[string]string{"bucketId": testBucketID, "localAlias": "mine", "accessKeyId": testKeyID}},
		{"remove global", http.MethodDelete, `{"globalAlias":"extra"}`, "/v2/RemoveBucketAlias",
			map[string]string{"bucketId": testBucketID, "globalAlias": "extra"}},
		// Removal does not apply the naming rules, so legacy names stay removable.
		{"remove local legacy name", http.MethodDelete, `{"localAlias":"Old_Name","accessKeyId":"` + testKeyID + `"}`, "/v2/RemoveBucketAlias",
			map[string]string{"bucketId": testBucketID, "localAlias": "Old_Name", "accessKeyId": testKeyID}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			garage, calls := newFakeAliasGarage(t, 0, "")
			c := newNodeTestClient(t, garage.URL)
			bucketInfoCache.put("stale", garageBucketInfo{})
			t.Cleanup(bucketInfoCache.clear)

			rec := c.do(tc.method, aliasesPath(), tc.body)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"globalAliases":["backups","extra"]`) {
				t.Errorf("Garage's bucket info not forwarded: %s", rec.Body.String())
			}
			got := calls()
			if len(got) != 1 || got[0].path != tc.wantPath || got[0].method != http.MethodPost {
				t.Fatalf("calls = %+v, want one POST %s", got, tc.wantPath)
			}
			var sent map[string]string
			if err := json.Unmarshal([]byte(got[0].body), &sent); err != nil {
				t.Fatalf("upstream body %q: %v", got[0].body, err)
			}
			if len(sent) != len(tc.want) {
				t.Errorf("upstream body = %v, want %v", sent, tc.want)
			}
			for k, v := range tc.want {
				if sent[k] != v {
					t.Errorf("upstream %s = %q, want %q", k, sent[k], v)
				}
			}
			if _, ok := bucketInfoCache.get("stale"); ok {
				t.Error("list caches must be cleared after a successful alias change")
			}
		})
	}
}

func TestBucketAliasRejectsInvalidBodies(t *testing.T) {
	garage, calls := newFakeAliasGarage(t, 0, "")
	c := newNodeTestClient(t, garage.URL)

	for _, tc := range []struct {
		method, body string
	}{
		{http.MethodPost, `{}`},
		{http.MethodPost, `not json`},
		{http.MethodPost, `{"globalAlias":"a-b","localAlias":"c-d","accessKeyId":"GK1"}`},
		{http.MethodPost, `{"globalAlias":""}`},
		{http.MethodPost, `{"globalAlias":"ab"}`},
		{http.MethodPost, `{"globalAlias":"` + strings.Repeat("a", 64) + `"}`},
		{http.MethodPost, `{"globalAlias":"Upper"}`},
		{http.MethodPost, `{"globalAlias":"under_score"}`},
		{http.MethodPost, `{"globalAlias":"-start"}`},
		{http.MethodPost, `{"globalAlias":"end."}`},
		{http.MethodPost, `{"globalAlias":"192.168.1.1"}`},
		{http.MethodPost, `{"globalAlias":"foo-s3alias"}`},
		{http.MethodPost, `{"globalAlias":"ok-name","accessKeyId":"GK1"}`},
		{http.MethodPost, `{"globalAlias":"ok-name","bucketId":"other"}`},
		{http.MethodPost, `{"globalAlias":"ok-name"} {"globalAlias":"x"}`},
		{http.MethodPost, `{"localAlias":"mine"}`},
		{http.MethodPost, `{"localAlias":"mine","accessKeyId":" "}`},
		{http.MethodPost, `{"localAlias":"Bad!","accessKeyId":"GK1"}`},
		{http.MethodDelete, `{}`},
		{http.MethodDelete, `{"globalAlias":"  "}`},
		{http.MethodDelete, `{"localAlias":"mine"}`},
	} {
		rec := c.do(tc.method, aliasesPath(), tc.body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s %s: status = %d, want 400", tc.method, tc.body, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `"error"`) {
			t.Errorf("%s %s: expected JSON error, got %s", tc.method, tc.body, rec.Body.String())
		}
	}
	if got := calls(); len(got) != 0 {
		t.Errorf("invalid bodies must not reach Garage, got %+v", got)
	}
}

func TestBucketAliasForwardsGarageErrors(t *testing.T) {
	const msg = `{"code":"InvalidRequest","message":"Bad request: Bucket backups doesn't have other aliases, please delete it instead of just unaliasing."}`
	garage, _ := newFakeAliasGarage(t, http.StatusBadRequest, msg)
	c := newNodeTestClient(t, garage.URL)
	bucketInfoCache.put("kept", garageBucketInfo{})
	t.Cleanup(bucketInfoCache.clear)

	rec := c.do(http.MethodDelete, aliasesPath(), `{"globalAlias":"backups"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "doesn't have other aliases") {
		t.Errorf("status = %d body = %s, want Garage's 400 forwarded", rec.Code, rec.Body.String())
	}
	if _, ok := bucketInfoCache.get("kept"); !ok {
		t.Error("caches must be kept when Garage rejected the change")
	}
}

// TestBucketAliasIntegration adds and removes global and local aliases on a
// real Garage when GARAGE_TEST_ADMIN_ENDPOINT / GARAGE_TEST_ADMIN_TOKEN are
// set. It creates an i378-* bucket and key and deletes them afterwards.
func TestBucketAliasIntegration(t *testing.T) {
	endpoint := os.Getenv("GARAGE_TEST_ADMIN_ENDPOINT")
	if endpoint == "" {
		t.Skip("GARAGE_TEST_ADMIN_ENDPOINT not set")
	}
	client := &GarageAdminClient{baseURL: endpoint, token: os.Getenv("GARAGE_TEST_ADMIN_TOKEN"), httpClient: &http.Client{Timeout: 10 * time.Second}}
	r := chi.NewRouter()
	r.Post("/api/buckets/{id}/aliases", handleBucketAlias(client, true))
	r.Delete("/api/buckets/{id}/aliases", handleBucketAlias(client, false))
	type info struct {
		GlobalAliases []string `json:"globalAliases"`
		Keys          []struct {
			AccessKeyID        string   `json:"accessKeyId"`
			BucketLocalAliases []string `json:"bucketLocalAliases"`
		} `json:"keys"`
	}
	do := func(method, path, body string) info {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s: %d %s", method, body, rec.Code, rec.Body.String())
		}
		var out info
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return out
	}
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

	var key struct {
		AccessKeyID string `json:"accessKeyId"`
	}
	if err := garageRequestJSON(context.Background(), client, http.MethodPost, "/v2/CreateKey", []byte(`{"name":"i378-key-`+suffix+`"}`), &key); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { deleteGarage("/v2/DeleteKey?id=" + key.AccessKeyID) })
	var bucket struct {
		ID string `json:"id"`
	}
	mainAlias := "i378-main-" + suffix
	if err := garageRequestJSON(context.Background(), client, http.MethodPost, "/v2/CreateBucket", []byte(`{"globalAlias":"`+mainAlias+`"}`), &bucket); err != nil {
		t.Fatal(err)
	}
	// DeleteBucket needs the bucket empty; aliases are dropped with it.
	t.Cleanup(func() { deleteGarage("/v2/DeleteBucket?id=" + bucket.ID) })

	path := "/api/buckets/" + bucket.ID + "/aliases"
	extra := "i378-extra-" + suffix
	local := "i378-local-" + suffix

	got := do(http.MethodPost, path, `{"globalAlias":"`+extra+`"}`)
	if !slices.Contains(got.GlobalAliases, extra) || !slices.Contains(got.GlobalAliases, mainAlias) {
		t.Errorf("after add global: %+v", got.GlobalAliases)
	}
	got = do(http.MethodPost, path, `{"localAlias":"`+local+`","accessKeyId":"`+key.AccessKeyID+`"}`)
	found := false
	for _, k := range got.Keys {
		if k.AccessKeyID == key.AccessKeyID && slices.Contains(k.BucketLocalAliases, local) {
			found = true
		}
	}
	if !found {
		t.Errorf("after add local: keys = %+v", got.Keys)
	}
	got = do(http.MethodDelete, path, `{"localAlias":"`+local+`","accessKeyId":"`+key.AccessKeyID+`"}`)
	for _, k := range got.Keys {
		if slices.Contains(k.BucketLocalAliases, local) {
			t.Errorf("local alias not removed: %+v", got.Keys)
		}
	}
	got = do(http.MethodDelete, path, `{"globalAlias":"`+extra+`"}`)
	if slices.Contains(got.GlobalAliases, extra) || !slices.Contains(got.GlobalAliases, mainAlias) {
		t.Errorf("after remove global: %+v", got.GlobalAliases)
	}

	// Garage refuses to remove the very last alias; the error is forwarded.
	req := httptest.NewRequest(http.MethodDelete, path, strings.NewReader(`{"globalAlias":"`+mainAlias+`"}`))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code < 400 || rec.Code >= 500 {
		t.Errorf("removing the last alias: status %d %s, want a 4xx from Garage", rec.Code, rec.Body.String())
	}
}
