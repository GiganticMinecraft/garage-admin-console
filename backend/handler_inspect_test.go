package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

const inspectBucketID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// inspectAgainst runs GET path against a fake Garage whose InspectObject
// handler is h, and reports whether Garage was called at all.
func inspectAgainst(t *testing.T, path string, h http.HandlerFunc) (*httptest.ResponseRecorder, bool) {
	t.Helper()
	called := false
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/InspectObject", func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		h(w, r)
	})
	garage := httptest.NewServer(mux)
	defer garage.Close()
	handler, store := setupTestRouter(t, garage.URL)

	req := authenticatedRequest(t, store, http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec, called
}

func TestInspectObjectForwardsBucketIDAndKey(t *testing.T) {
	// A key with characters that need escaping must reach Garage intact.
	key := "dir/a b&c=d+e.json"
	body := `{"bucketId":"` + inspectBucketID + `","key":"x","versions":[{"uuid":"u1","timestamp":"2026-01-01T00:00:00Z","encrypted":false,"uploading":false,"aborted":false,"deleteMarker":false,"inline":false,"size":10,"etag":"e","blocks":[{"partNumber":1,"offset":0,"hash":"h","size":10}]}]}`
	rec, called := inspectAgainst(t, "/api/buckets/"+inspectBucketID+"/objects/inspect?key="+url.QueryEscape(key),
		func(w http.ResponseWriter, r *http.Request) {
			if got := r.URL.Query().Get("bucketId"); got != inspectBucketID {
				t.Errorf("bucketId = %q", got)
			}
			if got := r.URL.Query().Get("key"); got != key {
				t.Errorf("key = %q, want %q", got, key)
			}
			if r.Header.Get("Authorization") == "" {
				t.Error("Authorization header missing")
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(body))
		})
	if !called {
		t.Fatal("Garage was not called")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != body {
		t.Errorf("body = %s, want passthrough", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q", ct)
	}
}

// Garage answers NoSuchKey with 404; the status (and body) must pass through.
func TestInspectObjectPassesThroughGarageErrors(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
	}{
		{http.StatusNotFound, `{"code":"NoSuchKey","message":"Key not found","region":"garage","path":"/v2/InspectObject"}`},
		{http.StatusBadRequest, `{"code":"InvalidRequest","message":"Invalid bucket id"}`},
		{http.StatusInternalServerError, `{"code":"InternalError","message":"boom"}`},
	} {
		rec, _ := inspectAgainst(t, "/api/buckets/"+inspectBucketID+"/objects/inspect?key=missing",
			func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			})
		if rec.Code != tc.status {
			t.Errorf("status = %d, want %d", rec.Code, tc.status)
		}
		if !strings.Contains(rec.Body.String(), "message") {
			t.Errorf("body = %s, want Garage error body", rec.Body.String())
		}
	}
}

// Only a full hex bucket ID is accepted; aliases and partial IDs never reach Garage.
func TestInspectObjectRejectsNonIDBucket(t *testing.T) {
	for _, id := range []string{"pyroscope", "0123456789abcdef", inspectBucketID + "00", strings.Replace(inspectBucketID, "0", "g", 1)} {
		rec, called := inspectAgainst(t, "/api/buckets/"+id+"/objects/inspect?key=a", func(w http.ResponseWriter, r *http.Request) {})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("id %q: status = %d, want 400", id, rec.Code)
		}
		if called {
			t.Errorf("id %q: Garage was called", id)
		}
	}
}

func TestInspectObjectRequiresKey(t *testing.T) {
	rec, called := inspectAgainst(t, "/api/buckets/"+inspectBucketID+"/objects/inspect", func(w http.ResponseWriter, r *http.Request) {})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	if called {
		t.Error("Garage was called without a key")
	}
}
