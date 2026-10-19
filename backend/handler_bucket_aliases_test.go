package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
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

const aliasesPath = "/api/buckets/" + testBucketID + "/aliases"

func TestBucketAliasForwardsToGarage(t *testing.T) {
	for _, tc := range []struct {
		name, method, path, body, wantPath string
		want                               map[string]string
	}{
		{"add global", http.MethodPost, aliasesPath, `{"globalAlias":"extra"}`, "/v2/AddBucketAlias",
			map[string]string{"bucketId": testBucketID, "globalAlias": "extra"}},
		{"add local", http.MethodPost, aliasesPath, `{"localAlias":"mine","accessKeyId":"` + testKeyID + `"}`, "/v2/AddBucketAlias",
			map[string]string{"bucketId": testBucketID, "localAlias": "mine", "accessKeyId": testKeyID}},
		// Naming rules are Garage's to enforce: the backend forwards the name.
		{"add global any name", http.MethodPost, aliasesPath, `{"globalAlias":"Not_Valid"}`, "/v2/AddBucketAlias",
			map[string]string{"bucketId": testBucketID, "globalAlias": "Not_Valid"}},
		{"remove global", http.MethodDelete, aliasesPath + "/extra.example", "", "/v2/RemoveBucketAlias",
			map[string]string{"bucketId": testBucketID, "globalAlias": "extra.example"}},
		{"remove local", http.MethodDelete, aliasesPath + "/mine?accessKeyId=" + testKeyID, "", "/v2/RemoveBucketAlias",
			map[string]string{"bucketId": testBucketID, "localAlias": "mine", "accessKeyId": testKeyID}},
		{"remove escaped name", http.MethodDelete, aliasesPath + "/" + url.PathEscape("a b/c") + "?accessKeyId=" + testKeyID, "", "/v2/RemoveBucketAlias",
			map[string]string{"bucketId": testBucketID, "localAlias": "a b/c", "accessKeyId": testKeyID}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			garage, calls := newFakeAliasGarage(t, 0, "")
			c := newNodeTestClient(t, garage.URL)
			bucketInfoCache.put("stale", garageBucketInfo{})
			t.Cleanup(bucketInfoCache.clear)

			rec := c.do(tc.method, tc.path, tc.body)
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

func TestBucketAliasRejectsInvalidRequests(t *testing.T) {
	garage, calls := newFakeAliasGarage(t, 0, "")
	c := newNodeTestClient(t, garage.URL)

	for _, tc := range []struct {
		method, path, body string
	}{
		{http.MethodPost, aliasesPath, `{}`},
		{http.MethodPost, aliasesPath, `not json`},
		{http.MethodPost, aliasesPath, `{"globalAlias":"a-b","localAlias":"c-d","accessKeyId":"GK1"}`},
		{http.MethodPost, aliasesPath, `{"globalAlias":""}`},
		{http.MethodPost, aliasesPath, `{"globalAlias":"  "}`},
		{http.MethodPost, aliasesPath, `{"globalAlias":"ok-name","accessKeyId":"GK1"}`},
		{http.MethodPost, aliasesPath, `{"globalAlias":"ok-name","bucketId":"other"}`},
		{http.MethodPost, aliasesPath, `{"globalAlias":"ok-name"} {"globalAlias":"x"}`},
		{http.MethodPost, aliasesPath, `{"localAlias":"mine"}`},
		{http.MethodPost, aliasesPath, `{"localAlias":"","accessKeyId":"GK1"}`},
		{http.MethodPost, aliasesPath, `{"localAlias":"mine","accessKeyId":" "}`},
		{http.MethodDelete, aliasesPath + "/%20", ""},
		{http.MethodDelete, aliasesPath + "/mine?accessKeyId=", ""},
	} {
		rec := c.do(tc.method, tc.path, tc.body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s %s %s: status = %d, want 400", tc.method, tc.path, tc.body, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `"error"`) {
			t.Errorf("%s %s %s: expected JSON error, got %s", tc.method, tc.path, tc.body, rec.Body.String())
		}
	}
	if got := calls(); len(got) != 0 {
		t.Errorf("invalid requests must not reach Garage, got %+v", got)
	}
}

func TestBucketAliasForwardsGarageErrors(t *testing.T) {
	const msg = `{"code":"InvalidRequest","message":"Bad request: Bucket backups doesn't have other aliases, please delete it instead of just unaliasing."}`
	garage, _ := newFakeAliasGarage(t, http.StatusBadRequest, msg)
	c := newNodeTestClient(t, garage.URL)
	bucketInfoCache.put("kept", garageBucketInfo{})
	t.Cleanup(bucketInfoCache.clear)

	rec := c.do(http.MethodDelete, aliasesPath+"/backups", "")
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
	r.Post("/api/buckets/{id}/aliases", handleAddBucketAlias(client))
	r.Delete("/api/buckets/{id}/aliases/{alias}", handleRemoveBucketAlias(client))
	type info struct {
		GlobalAliases []string `json:"globalAliases"`
		Keys          []struct {
			AccessKeyID        string   `json:"accessKeyId"`
			BucketLocalAliases []string `json:"bucketLocalAliases"`
		} `json:"keys"`
	}
	send := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
	do := func(method, path, body string) info {
		t.Helper()
		rec := send(method, path, body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s %s: %d %s", method, path, body, rec.Code, rec.Body.String())
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

	// Garage's own naming check is forwarded as a client error.
	if rec := send(http.MethodPost, path, `{"globalAlias":"I378_Bad"}`); rec.Code < 400 || rec.Code >= 500 {
		t.Errorf("invalid name: status %d %s, want a 4xx from Garage", rec.Code, rec.Body.String())
	}

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
	got = do(http.MethodDelete, path+"/"+local+"?accessKeyId="+key.AccessKeyID, "")
	for _, k := range got.Keys {
		if slices.Contains(k.BucketLocalAliases, local) {
			t.Errorf("local alias not removed: %+v", got.Keys)
		}
	}
	got = do(http.MethodDelete, path+"/"+extra, "")
	if slices.Contains(got.GlobalAliases, extra) || !slices.Contains(got.GlobalAliases, mainAlias) {
		t.Errorf("after remove global: %+v", got.GlobalAliases)
	}

	// Garage refuses to remove the very last alias; the error is forwarded.
	if rec := send(http.MethodDelete, path+"/"+mainAlias, ""); rec.Code < 400 || rec.Code >= 500 {
		t.Errorf("removing the last alias: status %d %s, want a 4xx from Garage", rec.Code, rec.Body.String())
	}
}
