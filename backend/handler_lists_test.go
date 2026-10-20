package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// setListVar overrides one of the list tuning knobs for the duration of a test.
func setListVar[T any](t *testing.T, p *T, v T) {
	t.Helper()
	old := *p
	*p = v
	t.Cleanup(func() { *p = old })
}

func newListTestClient(url string) *GarageAdminClient {
	return &GarageAdminClient{baseURL: url, token: "test-token", httpClient: http.DefaultClient}
}

// servePage answers a Garage *Info list request: offset is the inclusive ID of
// the first entry, limit the page size (default def).
func servePage(w http.ResponseWriter, r *http.Request, ids []string, def int, render func(id string) map[string]any) {
	limit := def
	if l := r.URL.Query().Get("limit"); l != "" {
		limit, _ = strconv.Atoi(l)
	}
	start := 0
	if off := r.URL.Query().Get("offset"); off != "" {
		start = sort.SearchStrings(ids, off)
	}
	end := min(start+limit, len(ids))
	out := []map[string]any{}
	for _, id := range ids[start:end] {
		out = append(out, render(id))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func decodeList[T any](t *testing.T, rr *httptest.ResponseRecorder) listResponse[T] {
	t.Helper()
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var res listResponse[T]
	if err := json.Unmarshal(rr.Body.Bytes(), &res); err != nil {
		t.Fatalf("decoding %s: %v", rr.Body.String(), err)
	}
	return res
}

func get(h http.Handler, path string) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
	return rr
}

func TestListBucketsUsesInfoEndpointWithPagination(t *testing.T) {
	setListVar(t, &infoPageLimit, 2)
	ids := []string{"b1", "b2", "b3", "b4", "b5"}
	var infoCalls, perItemCalls atomic.Int32

	mux := http.NewServeMux()
	mux.HandleFunc("/v2/ListBucketsInfo", func(w http.ResponseWriter, r *http.Request) {
		infoCalls.Add(1)
		servePage(w, r, ids, 1000, func(id string) map[string]any {
			return map[string]any{
				"id": id, "created": "2026-01-01T00:00:00Z", "globalAliases": []string{"alias-" + id},
				"keys": []map[string]any{
					{"accessKeyId": "GK1", "name": "k", "bucketLocalAliases": []string{"local-" + id},
						"permissions": map[string]any{"read": true, "write": true, "owner": false}},
					{"accessKeyId": "GK2", "name": "k2", "bucketLocalAliases": []string{},
						"permissions": map[string]any{"read": true}},
				},
				"objects": 3, "bytes": 1024, "unfinishedMultipartUploads": 1,
				"quotas": map[string]any{"maxSize": 4096, "maxObjects": nil},
			}
		})
	})
	mux.HandleFunc("/v2/GetBucketInfo", func(w http.ResponseWriter, r *http.Request) { perItemCalls.Add(1) })
	mux.HandleFunc("/v2/ListBuckets", func(w http.ResponseWriter, r *http.Request) { t.Error("fallback must not be used") })
	gs := httptest.NewServer(mux)
	defer gs.Close()

	res := decodeList[bucketListItem](t, get(handleListBuckets(newListTestClient(gs.URL)), "/api/buckets"))
	if res.Truncated {
		t.Error("expected truncated=false")
	}
	if len(res.Items) != len(ids) {
		t.Fatalf("expected %d unique buckets, got %d: %+v", len(ids), len(res.Items), res.Items)
	}
	for i, b := range res.Items {
		if b.ID != ids[i] {
			t.Errorf("item %d: id %q, want %q (duplicate page boundary?)", i, b.ID, ids[i])
		}
	}
	b := res.Items[0]
	if b.Objects == nil || *b.Objects != 3 || b.Bytes == nil || *b.Bytes != 1024 || b.KeyCount == nil || *b.KeyCount != 2 {
		t.Errorf("stats not filled: %+v", b)
	}
	if b.UnfinishedMultipartUploads == nil || *b.UnfinishedMultipartUploads != 1 {
		t.Errorf("unfinishedMultipartUploads not filled: %+v", b)
	}
	if b.Quotas == nil || b.Quotas.MaxSize == nil || *b.Quotas.MaxSize != 4096 || b.Quotas.MaxObjects != nil {
		t.Errorf("quotas not filled: %+v", b.Quotas)
	}
	if len(b.LocalAliases) != 1 || b.LocalAliases[0] != (bucketLocalAlias{AccessKeyID: "GK1", Alias: "local-b1"}) {
		t.Errorf("local aliases not derived from keys: %+v", b.LocalAliases)
	}
	if b.Created == nil || *b.Created != "2026-01-01T00:00:00Z" {
		t.Errorf("created not filled: %v", b.Created)
	}
	wantKeys := []bucketListKey{
		{AccessKeyID: "GK1", Read: true, Write: true},
		{AccessKeyID: "GK2", Read: true},
	}
	if fmt.Sprint(b.Keys) != fmt.Sprint(wantKeys) {
		t.Errorf("keys not filled from ListBucketsInfo: got %+v, want %+v", b.Keys, wantKeys)
	}
	// 5 items, page size 2, each later page repeats the offset entry:
	// [b1 b2] [b2 b3] [b3 b4] [b4 b5] [b5] -> 5 calls.
	if got := infoCalls.Load(); got != 5 {
		t.Errorf("expected 5 ListBucketsInfo calls, got %d", got)
	}
	if perItemCalls.Load() != 0 {
		t.Error("GetBucketInfo must not be called when ListBucketsInfo works")
	}
}

func TestListBucketsInfoTruncatedAtMaxPages(t *testing.T) {
	setListVar(t, &infoPageLimit, 2)
	setListVar(t, &infoMaxPages, 2)
	ids := []string{"b1", "b2", "b3", "b4", "b5"}
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/ListBucketsInfo", func(w http.ResponseWriter, r *http.Request) {
		servePage(w, r, ids, 1000, func(id string) map[string]any { return map[string]any{"id": id} })
	})
	gs := httptest.NewServer(mux)
	defer gs.Close()

	res := decodeList[bucketListItem](t, get(handleListBuckets(newListTestClient(gs.URL)), "/api/buckets"))
	if !res.Truncated {
		t.Error("expected truncated=true")
	}
	if len(res.Items) != 3 {
		t.Errorf("expected 3 items from 2 pages, got %d", len(res.Items))
	}
}

// legacyBucketServer fakes Garage v2.4.x: no ListBucketsInfo, ListBuckets +
// GetBucketInfo per bucket.
type legacyBucketServer struct {
	*httptest.Server
	infoCalls   atomic.Int32
	perItem     atomic.Int32
	inFlight    atomic.Int32
	maxInFlight atomic.Int32
}

func newLegacyBucketServer(t *testing.T, ids []string, missing string) *legacyBucketServer {
	s := &legacyBucketServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/ListBucketsInfo", func(w http.ResponseWriter, r *http.Request) {
		s.infoCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"code":"InvalidRequest","message":"Bad request: Unknown API endpoint: GET /v2/ListBucketsInfo"}`))
	})
	mux.HandleFunc("/v2/ListBuckets", func(w http.ResponseWriter, r *http.Request) {
		out := []map[string]any{}
		for _, id := range ids {
			out = append(out, map[string]any{
				"id": id, "created": "2026-01-01T00:00:00Z", "globalAliases": []string{"alias-" + id},
				"localAliases": []map[string]string{{"accessKeyId": "GK1", "alias": "l-" + id}},
			})
		}
		json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("/v2/GetBucketInfo", func(w http.ResponseWriter, r *http.Request) {
		s.perItem.Add(1)
		n := s.inFlight.Add(1)
		defer s.inFlight.Add(-1)
		for {
			m := s.maxInFlight.Load()
			if n <= m || s.maxInFlight.CompareAndSwap(m, n) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		id := r.URL.Query().Get("id")
		if id == missing {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"code":"NoSuchBucket","message":"Bucket not found"}`))
			return
		}
		fmt.Fprintf(w, `{"id":%q,"keys":[{"accessKeyId":"GK1","name":"k","bucketLocalAliases":[],"permissions":{"read":true,"write":false,"owner":true}}],"objects":7,"bytes":70,"unfinishedMultipartUploads":0,"quotas":{"maxSize":null,"maxObjects":10}}`, id)
	})
	mux.HandleFunc("/v2/CreateBucket", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":"new"}`))
	})
	s.Server = httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

func TestListBucketsFallsBackToLegacyAPI(t *testing.T) {
	var ids []string
	for i := range 40 {
		ids = append(ids, fmt.Sprintf("bucket%02d", i))
	}
	gs := newLegacyBucketServer(t, ids, "bucket03")
	client := newListTestClient(gs.URL)
	h := handleListBuckets(client)

	res := decodeList[bucketListItem](t, get(h, "/api/buckets"))
	if res.Truncated {
		t.Error("expected truncated=false")
	}
	if len(res.Items) != len(ids) {
		t.Fatalf("expected %d buckets, got %d", len(ids), len(res.Items))
	}
	for i, b := range res.Items {
		if b.ID != ids[i] {
			t.Fatalf("order not preserved: item %d is %q", i, b.ID)
		}
		if len(b.LocalAliases) != 1 || b.LocalAliases[0].Alias != "l-"+b.ID {
			t.Errorf("%s: local aliases from ListBuckets lost: %+v", b.ID, b.LocalAliases)
		}
		if b.ID == "bucket03" {
			if b.Objects != nil || b.KeyCount != nil || b.Quotas != nil || b.Keys != nil {
				t.Errorf("failed lookup should leave stats null: %+v", b)
			}
			continue
		}
		if b.Objects == nil || *b.Objects != 7 || b.Bytes == nil || *b.Bytes != 70 || b.KeyCount == nil || *b.KeyCount != 1 {
			t.Errorf("%s: stats not filled: %+v", b.ID, b)
		}
		if b.Quotas == nil || b.Quotas.MaxObjects == nil || *b.Quotas.MaxObjects != 10 {
			t.Errorf("%s: quotas not filled: %+v", b.ID, b.Quotas)
		}
		if len(b.Keys) != 1 || b.Keys[0] != (bucketListKey{AccessKeyID: "GK1", Read: true, Owner: true}) {
			t.Errorf("%s: keys not filled from GetBucketInfo: %+v", b.ID, b.Keys)
		}
	}
	if got := gs.maxInFlight.Load(); got > int32(enrichWorkers) {
		t.Errorf("expected at most %d concurrent GetBucketInfo calls, saw %d", enrichWorkers, got)
	}
	if got := gs.maxInFlight.Load(); got < 2 {
		t.Errorf("expected GetBucketInfo calls to run concurrently, max in flight %d", got)
	}
	if got := gs.infoCalls.Load(); got != 1 {
		t.Errorf("expected exactly 1 ListBucketsInfo probe, got %d", got)
	}
	first := gs.perItem.Load()
	if first != int32(len(ids)) {
		t.Errorf("expected %d GetBucketInfo calls, got %d", len(ids), first)
	}

	// A refetch within the TTL is served from cache (only the failed lookup is retried).
	decodeList[bucketListItem](t, get(h, "/api/buckets"))
	if got := gs.perItem.Load() - first; got != 1 {
		t.Errorf("expected only the uncached bucket to be re-fetched, got %d calls", got)
	}

	// A successful mutation drops the cache.
	rr := httptest.NewRecorder()
	handleCreateBucket(client).ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/api/buckets", strings.NewReader(`{}`)))
	before := gs.perItem.Load()
	decodeList[bucketListItem](t, get(h, "/api/buckets"))
	if got := gs.perItem.Load() - before; got != int32(len(ids)) {
		t.Errorf("expected cache to be invalidated after create, got %d calls", got)
	}
	// The "no *Info endpoint" verdict is remembered: no further probes.
	if got := gs.infoCalls.Load(); got != 1 {
		t.Errorf("expected ListBucketsInfo to be probed once across requests, got %d", got)
	}
}

func TestListBucketsInfoLaterPage400IsError(t *testing.T) {
	setListVar(t, &infoPageLimit, 2)
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/ListBucketsInfo", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("offset") != "" {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"code":"InvalidRequest","message":"Bad request: invalid bucket id"}`))
			return
		}
		w.Write([]byte(`[{"id":"b1"},{"id":"b2"}]`))
	})
	mux.HandleFunc("/v2/ListBuckets", func(w http.ResponseWriter, r *http.Request) { t.Error("must not fall back on a later-page 400") })
	gs := httptest.NewServer(mux)
	defer gs.Close()

	rr := get(handleListBuckets(newListTestClient(gs.URL)), "/api/buckets")
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "invalid bucket id") {
		t.Errorf("expected the later-page 400 to be forwarded, got %d %s", rr.Code, rr.Body.String())
	}
}

func TestListBucketsInfoUndecodableFallsBack(t *testing.T) {
	gs := newLegacyBucketServer(t, []string{"a"}, "")
	// Wrap the legacy fake so ListBucketsInfo answers 200 with a non-array body.
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/ListBucketsInfo", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<html>not garage</html>`))
	})
	mux.Handle("/", gs.Config.Handler)
	front := httptest.NewServer(mux)
	defer front.Close()

	res := decodeList[bucketListItem](t, get(handleListBuckets(newListTestClient(front.URL)), "/api/buckets"))
	if len(res.Items) != 1 || res.Items[0].Objects == nil {
		t.Errorf("expected fallback rows, got %+v", res.Items)
	}
}

func TestListBucketsInfoStopsWithoutProgress(t *testing.T) {
	setListVar(t, &infoPageLimit, 2)
	var calls atomic.Int32
	mux := http.NewServeMux()
	// A broken upstream that ignores offset and always returns the first page.
	mux.HandleFunc("/v2/ListBucketsInfo", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Write([]byte(`[{"id":"b1"},{"id":"b2"}]`))
	})
	gs := httptest.NewServer(mux)
	defer gs.Close()

	res := decodeList[bucketListItem](t, get(handleListBuckets(newListTestClient(gs.URL)), "/api/buckets"))
	if !res.Truncated || len(res.Items) != 2 {
		t.Errorf("expected 2 unique items and truncated=true, got %+v", res)
	}
	if got := calls.Load(); got != 2 {
		t.Errorf("expected pagination to stop after the repeated page, got %d calls", got)
	}
}

func TestListBucketsLegacyTruncated(t *testing.T) {
	setListVar(t, &legacyListLimit, 3)
	gs := newLegacyBucketServer(t, []string{"a", "b", "c"}, "")
	res := decodeList[bucketListItem](t, get(handleListBuckets(newListTestClient(gs.URL)), "/api/buckets"))
	if !res.Truncated {
		t.Error("expected truncated=true when ListBuckets returns its limit")
	}
}

func TestListBucketsForwardsGarageError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/ListBucketsInfo", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"code":"InternalError","message":"quorum not reached"}`))
	})
	mux.HandleFunc("/v2/ListBuckets", func(w http.ResponseWriter, r *http.Request) { t.Error("must not fall back on 500") })
	gs := httptest.NewServer(mux)
	defer gs.Close()

	rr := get(handleListBuckets(newListTestClient(gs.URL)), "/api/buckets")
	if rr.Code != http.StatusInternalServerError || !strings.Contains(rr.Body.String(), "quorum not reached") {
		t.Errorf("expected Garage error forwarded, got %d %s", rr.Code, rr.Body.String())
	}
}

func TestListBucketsLegacyListErrorForwarded(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/ListBucketsInfo", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	mux.HandleFunc("/v2/ListBuckets", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"code":"Unavailable","message":"cluster down"}`))
	})
	gs := httptest.NewServer(mux)
	defer gs.Close()

	rr := get(handleListBuckets(newListTestClient(gs.URL)), "/api/buckets")
	if rr.Code != http.StatusServiceUnavailable || !strings.Contains(rr.Body.String(), "cluster down") {
		t.Errorf("expected ListBuckets error forwarded, got %d %s", rr.Code, rr.Body.String())
	}
}

func TestListKeysUsesInfoEndpoint(t *testing.T) {
	setListVar(t, &infoPageLimit, 2)
	ids := []string{"GK1", "GK2", "GK3"}
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/ListKeysInfo", func(w http.ResponseWriter, r *http.Request) {
		servePage(w, r, ids, 1000, func(id string) map[string]any {
			exp := any(nil)
			if id == "GK2" {
				exp = "2020-01-01T00:00:00Z"
			}
			return map[string]any{
				"accessKeyId": id, "name": "name-" + id, "created": "2026-01-01T00:00:00Z",
				"expiration": exp, "expired": id == "GK2",
				"permissions": map[string]bool{"createBucket": false},
				"buckets":     []map[string]any{{"id": "b1"}, {"id": "b2"}},
			}
		})
	})
	mux.HandleFunc("/v2/GetKeyInfo", func(w http.ResponseWriter, r *http.Request) { t.Error("GetKeyInfo must not be called") })
	gs := httptest.NewServer(mux)
	defer gs.Close()

	res := decodeList[keyListItem](t, get(handleListKeys(newListTestClient(gs.URL)), "/api/keys"))
	if len(res.Items) != 3 || res.Truncated {
		t.Fatalf("expected 3 keys, not truncated: %+v", res)
	}
	k := res.Items[1]
	if k.ID != "GK2" || k.Name != "name-GK2" || !k.Expired || k.Expiration == nil || k.BucketCount == nil || *k.BucketCount != 2 {
		t.Errorf("key not normalized: %+v", k)
	}
}

func TestListKeysFallsBackWithoutSecret(t *testing.T) {
	var mu sync.Mutex
	var queries []string
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/ListKeysInfo", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"code":"InvalidRequest","message":"Unknown API endpoint"}`))
	})
	mux.HandleFunc("/v2/ListKeys", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"id":"GKa","name":"a","created":"2026-01-01T00:00:00Z","expiration":null,"expired":false},` +
			`{"id":"GKb","name":"b","created":null,"expiration":"2020-01-01T00:00:00Z","expired":true}]`))
	})
	mux.HandleFunc("/v2/GetKeyInfo", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		queries = append(queries, r.URL.RawQuery)
		mu.Unlock()
		id := r.URL.Query().Get("id")
		fmt.Fprintf(w, `{"accessKeyId":%q,"name":"x","buckets":[{"id":"b1"}],"permissions":{"createBucket":false}}`, id)
	})
	gs := httptest.NewServer(mux)
	defer gs.Close()

	res := decodeList[keyListItem](t, get(handleListKeys(newListTestClient(gs.URL)), "/api/keys"))
	if len(res.Items) != 2 {
		t.Fatalf("expected 2 keys, got %+v", res.Items)
	}
	a, b := res.Items[0], res.Items[1]
	if a.ID != "GKa" || a.Name != "a" || a.Expired || a.BucketCount == nil || *a.BucketCount != 1 {
		t.Errorf("unexpected key a: %+v", a)
	}
	if b.ID != "GKb" || !b.Expired || b.Expiration == nil || *b.Expiration != "2020-01-01T00:00:00Z" {
		t.Errorf("unexpected key b: %+v", b)
	}
	for _, q := range queries {
		if strings.Contains(q, "showSecretKey") {
			t.Errorf("GetKeyInfo must not ask for the secret: %s", q)
		}
	}
	if len(queries) != 2 {
		t.Errorf("expected one GetKeyInfo per key, got %v", queries)
	}
}

// TestListsIntegration runs the list endpoints against a real Garage when
// GARAGE_TEST_ADMIN_ENDPOINT and GARAGE_TEST_ADMIN_TOKEN are set.
func TestListsIntegration(t *testing.T) {
	endpoint := os.Getenv("GARAGE_TEST_ADMIN_ENDPOINT")
	if endpoint == "" {
		t.Skip("GARAGE_TEST_ADMIN_ENDPOINT not set")
	}
	client := &GarageAdminClient{baseURL: endpoint, token: os.Getenv("GARAGE_TEST_ADMIN_TOKEN"), httpClient: &http.Client{Timeout: 10 * time.Second}}

	buckets := decodeList[bucketListItem](t, get(handleListBuckets(client), "/api/buckets"))
	if len(buckets.Items) == 0 {
		t.Fatal("expected at least one bucket")
	}
	for _, b := range buckets.Items {
		if b.Objects == nil || b.Bytes == nil || b.KeyCount == nil || b.Created == nil || b.Quotas == nil {
			t.Errorf("bucket %s not enriched: %+v", b.ID, b)
		}
	}
	keys := decodeList[keyListItem](t, get(handleListKeys(client), "/api/keys"))
	if len(keys.Items) == 0 {
		t.Fatal("expected at least one key")
	}
	for _, k := range keys.Items {
		if k.BucketCount == nil || k.Created == nil {
			t.Errorf("key %s not enriched: %+v", k.ID, k)
		}
	}
	raw := get(handleListKeys(client), "/api/keys").Body.String()
	if strings.Contains(raw, "secretAccessKey") {
		t.Error("key list must not contain secrets")
	}
}
