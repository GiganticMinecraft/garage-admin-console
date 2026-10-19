package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testConsoleKeyID = "GKc0ffee0000000000000000aa"

func consoleAccessPath(bucket string) string {
	return "/api/buckets/" + bucket + "/console-access"
}

// newConsoleAccessClient builds the router with the console's S3 key set,
// since the router reads GARAGE_S3_ACCESS_KEY when it is built.
func newConsoleAccessClient(t *testing.T, garageURL, keyID string) *nodeTestClient {
	t.Helper()
	t.Setenv("GARAGE_S3_ACCESS_KEY", keyID)
	t.Setenv("GARAGE_S3_SECRET_KEY", "super-secret-value")
	return newNodeTestClient(t, garageURL)
}

func TestGrantConsoleAccessAllowsReadWriteForConsoleKey(t *testing.T) {
	f := &fakePermGarage{perms: map[string]bucketKeyPerm{testKeyID: {Read: true}}}
	c := newConsoleAccessClient(t, f.server(t).URL, testConsoleKeyID)

	rec := c.do(http.MethodPost, consoleAccessPath(testBucketID), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	got := decodePermsResponse(t, rec)
	want := bucketKeyPerm{Read: true, Write: true}
	if got.Permissions != want || !got.Changed || got.AccessKeyID != testConsoleKeyID || got.BucketID != testBucketID {
		t.Errorf("response = %+v", got)
	}

	calls := f.mutations()
	if len(calls) != 1 || calls[0].path != "/v2/AllowBucketKey" {
		t.Fatalf("calls = %+v, want one AllowBucketKey", calls)
	}
	var sent struct {
		BucketID    string          `json:"bucketId"`
		AccessKeyID string          `json:"accessKeyId"`
		Permissions map[string]bool `json:"permissions"`
	}
	if err := json.Unmarshal([]byte(calls[0].body), &sent); err != nil {
		t.Fatal(err)
	}
	if sent.BucketID != testBucketID || sent.AccessKeyID != testConsoleKeyID {
		t.Errorf("sent = %+v", sent)
	}
	if !sent.Permissions["read"] || !sent.Permissions["write"] || sent.Permissions["owner"] {
		t.Errorf("permissions sent = %v, want read+write without owner", sent.Permissions)
	}
	// Other keys are untouched.
	if p := f.perms[testKeyID]; p != (bucketKeyPerm{Read: true}) {
		t.Errorf("other key perms = %+v", p)
	}
}

func TestGrantConsoleAccessNoOpWhenAlreadyGranted(t *testing.T) {
	f := &fakePermGarage{perms: map[string]bucketKeyPerm{testConsoleKeyID: {Read: true, Write: true}}}
	c := newConsoleAccessClient(t, f.server(t).URL, testConsoleKeyID)

	rec := c.do(http.MethodPost, consoleAccessPath(testBucketID), "{}")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if got := decodePermsResponse(t, rec); got.Changed {
		t.Errorf("changed = true, want false: %+v", got)
	}
	if calls := f.mutations(); len(calls) != 0 {
		t.Errorf("calls = %+v, want none", calls)
	}
}

func TestGrantConsoleAccessKeepsExistingOwner(t *testing.T) {
	f := &fakePermGarage{perms: map[string]bucketKeyPerm{testConsoleKeyID: {Read: true, Owner: true}}}
	c := newConsoleAccessClient(t, f.server(t).URL, testConsoleKeyID)

	rec := c.do(http.MethodPost, consoleAccessPath(testBucketID), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if got := decodePermsResponse(t, rec); got.Permissions != (bucketKeyPerm{Read: true, Write: true, Owner: true}) || !got.Changed {
		t.Errorf("response = %+v", got)
	}
	calls := f.mutations()
	if len(calls) != 1 || calls[0].path != "/v2/AllowBucketKey" || !strings.Contains(calls[0].body, `"write":true`) || strings.Contains(calls[0].body, `"read":true`) {
		t.Errorf("calls = %+v, want one AllowBucketKey for write only (no Deny)", calls)
	}
}

func TestGrantConsoleAccessRejectsOtherKeyInBody(t *testing.T) {
	f := &fakePermGarage{perms: map[string]bucketKeyPerm{}}
	c := newConsoleAccessClient(t, f.server(t).URL, testConsoleKeyID)

	rec := c.do(http.MethodPost, consoleAccessPath(testBucketID), `{"accessKeyId":"`+testKeyID+`"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if calls := f.mutations(); len(calls) != 0 {
		t.Errorf("calls = %+v, want none", calls)
	}
}

func TestGrantConsoleAccessWithoutConfiguredKey(t *testing.T) {
	f := &fakePermGarage{perms: map[string]bucketKeyPerm{}}
	c := newConsoleAccessClient(t, f.server(t).URL, "")

	rec := c.do(http.MethodPost, consoleAccessPath(testBucketID), "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", rec.Code, rec.Body.String())
	}
	if calls := f.mutations(); len(calls) != 0 {
		t.Errorf("calls = %+v, want none", calls)
	}
}

func TestGrantConsoleAccessForwardsGarageErrors(t *testing.T) {
	t.Run("unknown bucket", func(t *testing.T) {
		f := &fakePermGarage{perms: map[string]bucketKeyPerm{}}
		c := newConsoleAccessClient(t, f.server(t).URL, testConsoleKeyID)
		rec := c.do(http.MethodPost, consoleAccessPath("nope"), "")
		if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "NoSuchBucket") {
			t.Fatalf("status = %d body = %s, want Garage's 404", rec.Code, rec.Body.String())
		}
	})
	t.Run("AllowBucketKey fails", func(t *testing.T) {
		f := &fakePermGarage{perms: map[string]bucketKeyPerm{}, failPath: "/v2/AllowBucketKey", failStatus: http.StatusBadRequest}
		c := newConsoleAccessClient(t, f.server(t).URL, testConsoleKeyID)
		rec := c.do(http.MethodPost, consoleAccessPath(testBucketID), "")
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "NoSuchAccessKey") {
			t.Fatalf("status = %d body = %s, want Garage's 400", rec.Code, rec.Body.String())
		}
	})
}

func TestGrantConsoleAccessRequiresCSRFHeader(t *testing.T) {
	f := &fakePermGarage{perms: map[string]bucketKeyPerm{}}
	t.Setenv("GARAGE_S3_ACCESS_KEY", testConsoleKeyID)
	handler, store := setupTestRouter(t, f.server(t).URL)

	req := authenticatedRequest(t, store, http.MethodPost, consoleAccessPath(testBucketID), nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 without X-Requested-With", rec.Code)
	}

	req = authenticatedRequest(t, store, http.MethodPost, consoleAccessPath(testBucketID), strings.NewReader("{}"))
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("Content-Type", "text/plain")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for non-JSON body", rec.Code)
	}
	if calls := f.mutations(); len(calls) != 0 {
		t.Errorf("calls = %+v, want none", calls)
	}
}

func TestS3ConnectionExposesKeyIDButNotSecret(t *testing.T) {
	c := newConsoleAccessClient(t, "http://127.0.0.1:1", testConsoleKeyID)
	rec := c.do(http.MethodGet, "/api/s3/connection", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var got s3ConnectionInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.AccessKeyID != testConsoleKeyID {
		t.Errorf("accessKeyId = %q, want %q", got.AccessKeyID, testConsoleKeyID)
	}
	if strings.Contains(rec.Body.String(), "super-secret-value") {
		t.Errorf("secret key leaked: %s", rec.Body.String())
	}
}
