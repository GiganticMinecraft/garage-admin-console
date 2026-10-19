package main

import (
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

// garageGetJSON performs GET garagePath and decodes a 2xx JSON body into out.
// Non-2xx answers come back as *garageStatusError.
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
		return fmt.Errorf("decoding garage %s: %w", garagePath, err)
	}
	return nil
}

// isUnknownEndpoint reports whether err means Garage does not implement the
// endpoint (v2.4.x answers 400 InvalidRequest "Unknown API endpoint"; a proxy
// or an older build may answer 404).
func isUnknownEndpoint(err error) bool {
	var se *garageStatusError
	return errors.As(err, &se) && (se.status == http.StatusBadRequest || se.status == http.StatusNotFound)
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
func listAllInfo[T any](ctx context.Context, garageAdmin *GarageAdminClient, endpoint string, idOf func(T) string) ([]T, bool, error) {
	var all []T
	offset := ""
	for page := 0; page < infoMaxPages; page++ {
		q := url.Values{}
		q.Set("limit", fmt.Sprint(infoPageLimit))
		if offset != "" {
			q.Set("offset", offset)
		}
		var items []T
		if err := garageGetJSON(ctx, garageAdmin, endpoint+"?"+q.Encode(), &items); err != nil {
			return nil, false, err
		}
		full := len(items) >= infoPageLimit
		if offset != "" && len(items) > 0 && idOf(items[0]) == offset {
			items = items[1:]
		}
		all = append(all, items...)
		if !full || len(items) == 0 {
			return all, false, nil
		}
		offset = idOf(all[len(all)-1])
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
	now := time.Now()
	// Drop expired entries opportunistically so deleted items do not pile up.
	for k, e := range c.entries {
		if now.After(e.expires) {
			delete(c.entries, k)
		}
	}
	c.entries[key] = ttlEntry[T]{val: val, expires: now.Add(listInfoCacheTTL)}
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
// list reflects it immediately (permission grants change both sides' counts).
func invalidateListCaches() {
	bucketInfoCache.clear()
	keyInfoCache.clear()
}

// fetchInfoConcurrently calls fetch for every id with at most enrichWorkers in
// flight, reusing cached values. The result is aligned with ids; entries whose
// fetch failed are left nil (the list still renders them, without stats).
func fetchInfoConcurrently[T any](ctx context.Context, cache *ttlCache[T], cachePrefix string, ids []string, fetch func(ctx context.Context, id string) (T, error)) []*T {
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
