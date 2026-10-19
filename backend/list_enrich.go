package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// Shared plumbing for the enriched GET /api/buckets and GET /api/keys lists.
//
// Garage >= v2.5 has ListBucketsInfo / ListKeysInfo, which return the full
// GetBucketInfo / GetKeyInfo object for every entry (paginated by offset/limit,
// default limit 1000). Older Garage (v2.4.x, what production runs) answers 400
// "Unknown API endpoint" for them; there we list with ListBuckets / ListKeys
// (hard limit 10000) and fetch the per-item info concurrently, through a short
// TTL cache so that a list refetch does not re-issue N requests to Garage.

var (
	// infoPageLimit is the page size requested from ListBucketsInfo / ListKeysInfo.
	infoPageLimit = 1000
	// infoMaxPages bounds pagination so a misbehaving upstream cannot loop forever.
	infoMaxPages = 100
	// legacyListLimit is the number of entries ListBuckets / ListKeys return at
	// most on Garage v2.4.x; a full page means the list may have been cut off.
	legacyListLimit = 10000
	// enrichWorkers bounds concurrent GetBucketInfo / GetKeyInfo calls.
	enrichWorkers = 8
	// listInfoCacheTTL is how long a per-item info response is reused.
	listInfoCacheTTL = 15 * time.Second
	// infoUnsupportedTTL is how long we remember that a Garage lacks the *Info
	// list endpoints, so v2.4.x is not sent a doomed request on every refetch.
	infoUnsupportedTTL = 10 * time.Minute
)

// garageStatusError is a non-2xx answer from Garage, kept verbatim so the
// handler can forward the upstream status and message to the browser.
type garageStatusError struct {
	path        string
	status      int
	contentType string
	body        []byte
}

func (e *garageStatusError) Error() string {
	return fmt.Sprintf("garage %s returned %d", e.path, e.status)
}

// garageDecodeError is a 2xx answer from Garage whose body did not decode.
type garageDecodeError struct {
	path string
	err  error
}

func (e *garageDecodeError) Error() string {
	return fmt.Sprintf("decoding garage %s: %v", e.path, e.err)
}

func (e *garageDecodeError) Unwrap() error { return e.err }

// garageGetJSON performs GET garagePath and decodes a 2xx JSON body into out.
// Non-2xx answers come back as *garageStatusError, undecodable bodies as
// *garageDecodeError.
func garageGetJSON(ctx context.Context, garageAdmin *GarageAdminClient, garagePath string, out any) error {
	resp, err := garageAdmin.doRequest(ctx, http.MethodGet, garagePath, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading garage %s: %w", garagePath, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &garageStatusError{path: garagePath, status: resp.StatusCode, contentType: resp.Header.Get("Content-Type"), body: body}
	}
	if err := json.Unmarshal(body, out); err != nil {
		return &garageDecodeError{path: garagePath, err: err}
	}
	return nil
}

// errInfoUnsupported means Garage does not implement the *Info list endpoint.
var errInfoUnsupported = errors.New("garage does not support the *Info list endpoint")

// isUnknownEndpoint reports whether an error from a *Info list request means
// Garage does not implement the endpoint. Garage v2.4.x answers 400
// InvalidRequest "Unknown API endpoint"; a proxy or another build may answer
// 404 or something that is not the expected JSON array. Only the first page
// gets the benefit of the doubt: a 400 on a later page is a real error.
func isUnknownEndpoint(err error, firstPage bool) bool {
	var se *garageStatusError
	if errors.As(err, &se) {
		if se.status == http.StatusBadRequest && bytes.Contains(se.body, []byte("Unknown API endpoint")) {
			return true
		}
		return firstPage && (se.status == http.StatusBadRequest || se.status == http.StatusNotFound)
	}
	var de *garageDecodeError
	return firstPage && errors.As(err, &de)
}

// infoUnsupported remembers, per Garage base URL + endpoint, until when the
// *Info list endpoint is known to be missing.
var infoUnsupported = struct {
	sync.Mutex
	until map[string]time.Time
}{until: map[string]time.Time{}}

func infoKnownUnsupported(key string) bool {
	infoUnsupported.Lock()
	defer infoUnsupported.Unlock()
	return time.Now().Before(infoUnsupported.until[key])
}

func markInfoUnsupported(key string) {
	infoUnsupported.Lock()
	defer infoUnsupported.Unlock()
	infoUnsupported.until[key] = time.Now().Add(infoUnsupportedTTL)
}

// writeListError forwards a Garage error verbatim, or answers 502 for
// transport/decoding failures.
func writeListError(w http.ResponseWriter, r *http.Request, err error) {
	var se *garageStatusError
	if errors.As(err, &se) {
		ct := se.contentType
		if ct == "" {
			ct = "application/json"
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(se.status)
		w.Write(se.body)
		return
	}
	slog.ErrorContext(r.Context(), "garage list request failed", "error", err)
	http.Error(w, "Bad Gateway", http.StatusBadGateway)
}

// listResponse is the JSON body of GET /api/buckets and GET /api/keys.
type listResponse[T any] struct {
	Items []T `json:"items"`
	// Truncated is true when Garage's list limit was reached, so some entries
	// may be missing.
	Truncated bool `json:"truncated"`
}

func writeListJSON[T any](w http.ResponseWriter, items []T, truncated bool) {
	if items == nil {
		items = []T{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(listResponse[T]{Items: items, Truncated: truncated})
}

// listAllInfo pages through a Garage *Info list endpoint (ListBucketsInfo /
// ListKeysInfo). Garage's offset is the ID of the first entry to return, so
// every page after the first starts with the previous page's last entry,
// which is dropped. idOf extracts the entry ID used as the next offset.
//
// It returns errInfoUnsupported (and remembers it for infoUnsupportedTTL)
// when Garage lacks the endpoint. Pagination stops, reporting truncated, when
// the page cap is hit or the upstream stops making progress (repeats an
// offset or an already-seen ID).
func listAllInfo[T any](ctx context.Context, garageAdmin *GarageAdminClient, endpoint string, idOf func(T) string) ([]T, bool, error) {
	memoKey := garageAdmin.baseURL + "\x00" + endpoint
	if infoKnownUnsupported(memoKey) {
		return nil, false, errInfoUnsupported
	}

	var all []T
	seen := map[string]struct{}{}
	offset := ""
	for page := 0; page < infoMaxPages; page++ {
		q := url.Values{}
		q.Set("limit", fmt.Sprint(infoPageLimit))
		if offset != "" {
			q.Set("offset", offset)
		}
		var items []T
		if err := garageGetJSON(ctx, garageAdmin, endpoint+"?"+q.Encode(), &items); err != nil {
			if isUnknownEndpoint(err, page == 0) {
				markInfoUnsupported(memoKey)
				return nil, false, errInfoUnsupported
			}
			return nil, false, err
		}
		full := len(items) >= infoPageLimit
		if offset != "" && len(items) > 0 && idOf(items[0]) == offset {
			items = items[1:]
		}
		for _, it := range items {
			id := idOf(it)
			if _, dup := seen[id]; dup {
				slog.WarnContext(ctx, "garage list pagination repeated an entry; stopping", "endpoint", endpoint, "id", id)
				return all, true, nil
			}
			seen[id] = struct{}{}
			all = append(all, it)
		}
		if !full || len(items) == 0 {
			return all, false, nil
		}
		next := idOf(all[len(all)-1])
		if next == offset {
			slog.WarnContext(ctx, "garage list pagination made no progress; stopping", "endpoint", endpoint, "offset", offset)
			return all, true, nil
		}
		offset = next
	}
	return all, true, nil
}

// ttlCache is a small in-memory cache of per-item Garage info.
type ttlCache[T any] struct {
	mu      sync.Mutex
	entries map[string]ttlEntry[T]
}

type ttlEntry[T any] struct {
	val     T
	expires time.Time
}

func (c *ttlCache[T]) get(key string) (T, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Now().After(e.expires) {
		var zero T
		return zero, false
	}
	return e.val, true
}

func (c *ttlCache[T]) put(key string, val T) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]ttlEntry[T]{}
	}
	c.entries[key] = ttlEntry[T]{val: val, expires: time.Now().Add(listInfoCacheTTL)}
}

// purgeExpired drops expired entries so deleted items do not pile up. It is
// called once per list request rather than on every put.
func (c *ttlCache[T]) purgeExpired() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, e := range c.entries {
		if now.After(e.expires) {
			delete(c.entries, k)
		}
	}
}

func (c *ttlCache[T]) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = nil
}

var (
	bucketInfoCache ttlCache[garageBucketInfo]
	keyInfoCache    ttlCache[garageKeyInfo]
)

// invalidateListCaches drops cached bucket/key info after a mutation so the
// list reflects it immediately (permission grants change both sides' counts,
// object uploads/deletes change usage).
func invalidateListCaches() {
	bucketInfoCache.clear()
	keyInfoCache.clear()
}

// proxyGarageMutation forwards a mutating request to Garage (always POST, as
// the v2 admin API expects), streams the answer back, and invalidates the
// list caches when Garage accepted the change.
func proxyGarageMutation(w http.ResponseWriter, r *http.Request, garageAdmin *GarageAdminClient, garagePath string, body io.Reader) {
	resp, err := garageAdmin.doRequest(r.Context(), http.MethodPost, garagePath, body)
	if err != nil {
		slog.ErrorContext(r.Context(), "garage request failed", "path", garagePath, "error", err)
		http.Error(w, "Bad Gateway", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		invalidateListCaches()
	}
	forwardResponse(w, r, resp, garagePath)
}

// fetchInfoConcurrently calls fetch for every id with at most enrichWorkers in
// flight, reusing cached values. The result is aligned with ids; entries whose
// fetch failed are left nil (the list still renders them, without stats).
func fetchInfoConcurrently[T any](ctx context.Context, cache *ttlCache[T], cachePrefix string, ids []string, fetch func(ctx context.Context, id string) (T, error)) []*T {
	cache.purgeExpired()
	out := make([]*T, len(ids))
	var todo []int
	for i, id := range ids {
		if v, ok := cache.get(cachePrefix + id); ok {
			out[i] = &v
		} else {
			todo = append(todo, i)
		}
	}

	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < min(enrichWorkers, len(todo)); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				v, err := fetch(ctx, ids[i])
				if err != nil {
					if ctx.Err() == nil {
						slog.WarnContext(ctx, "garage info lookup failed", "id", ids[i], "error", err)
					}
					continue
				}
				cache.put(cachePrefix+ids[i], v)
				out[i] = &v
			}
		}()
	}
feed:
	for _, i := range todo {
		select {
		case jobs <- i:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	return out
}
