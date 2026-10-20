package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const (
	testImportKeyID  = "GK0123456789abcdef01234567"
	testImportSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

// importKeyGarage fakes POST /v2/ImportKey. It records the forwarded body and
// the number of calls, and answers with a fixed status / body.
type importKeyGarage struct {
	*httptest.Server
	mu    sync.Mutex
	body  string
	calls int
}

func newImportKeyGarage(t *testing.T, status int, respBody string) *importKeyGarage {
	t.Helper()
	g := &importKeyGarage{}
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/ImportKey", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		b, _ := io.ReadAll(r.Body)
		g.mu.Lock()
		g.calls++
		g.body = string(b)
		g.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write([]byte(respBody))
	})
	g.Server = httptest.NewServer(mux)
	t.Cleanup(g.Close)
	return g
}

func (g *importKeyGarage) got() (string, int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.body, g.calls
}

func doImportKey(t *testing.T, garageURL, body string) *httptest.ResponseRecorder {
	t.Helper()
	handler, store := setupTestRouter(t, garageURL)
	req := authenticatedRequest(t, store, http.MethodPost, "/api/keys/import", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestImportKeyForwards(t *testing.T) {
	// The shape Garage v2.4.1 answers (checked against a real instance): no
	// secretAccessKey.
	resp := `{"accessKeyId":"` + testImportKeyID + `","created":"2026-10-20T02:19:08.657Z","name":"migrated","expiration":null,"expired":false,"permissions":{"createBucket":false},"buckets":[]}`
	garage := newImportKeyGarage(t, http.StatusOK, resp)

	rec := doImportKey(t, garage.URL, `{"accessKeyId":"`+testImportKeyID+`","secretAccessKey":"`+testImportSecret+`","name":"  migrated "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body %s", rec.Code, rec.Body.String())
	}
	got, calls := garage.got()
	if calls != 1 {
		t.Fatalf("garage calls = %d, want 1", calls)
	}
	var fwd importKeyRequest
	if err := json.Unmarshal([]byte(got), &fwd); err != nil {
		t.Fatalf("forwarded body %q: %v", got, err)
	}
	if fwd.AccessKeyID != testImportKeyID || fwd.SecretAccessKey != testImportSecret || fwd.Name == nil || *fwd.Name != "migrated" {
		t.Errorf("forwarded body = %q", got)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response %q: %v", rec.Body.String(), err)
	}
	if out["accessKeyId"] != testImportKeyID || out["name"] != "migrated" {
		t.Errorf("response = %v", out)
	}
	if strings.Contains(rec.Body.String(), testImportSecret) {
		t.Errorf("response must not carry the secret: %s", rec.Body.String())
	}
}

func TestImportKeyBlankNameIsOmitted(t *testing.T) {
	for _, name := range []string{`""`, `"   "`, `"\t\n"`} {
		garage := newImportKeyGarage(t, http.StatusOK, `{"accessKeyId":"`+testImportKeyID+`","name":"Imported key"}`)
		rec := doImportKey(t, garage.URL, `{"accessKeyId":"`+testImportKeyID+`","secretAccessKey":"`+testImportSecret+`","name":`+name+`}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("name %s: status = %d body %s", name, rec.Code, rec.Body.String())
		}
		if got, _ := garage.got(); !strings.Contains(got, `"name":null`) {
			t.Errorf("name %s should be forwarded as null, got %q", name, got)
		}
	}
}

func TestImportKeyRejectsMalformedPair(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"invalid JSON", `{"accessKeyId":`},
		{"missing fields", `{}`},
		{"short id", `{"accessKeyId":"GK123","secretAccessKey":"` + testImportSecret + `"}`},
		{"id with slash", `{"accessKeyId":"GK0123/456789","secretAccessKey":"` + testImportSecret + `"}`},
		{"id with space", `{"accessKeyId":"GK0123 456789","secretAccessKey":"` + testImportSecret + `"}`},
		{"short secret", `{"accessKeyId":"` + testImportKeyID + `","secretAccessKey":"0123456789abcde"}`},
		{"secret with space", `{"accessKeyId":"` + testImportKeyID + `","secretAccessKey":"0123456789abcdef 0123"}`},
		{"secret non-ASCII", `{"accessKeyId":"` + testImportKeyID + `","secretAccessKey":"0123456789abcdefあいう"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			garage := newImportKeyGarage(t, http.StatusOK, `{}`)
			rec := doImportKey(t, garage.URL, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			if _, calls := garage.got(); calls != 0 {
				t.Errorf("malformed body must not reach Garage")
			}
			if strings.Contains(rec.Body.String(), testImportSecret) {
				t.Errorf("error response echoes the secret: %s", rec.Body.String())
			}
		})
	}
}

func TestImportKeyForwardsKeyAlreadyExists(t *testing.T) {
	garageErr := `{"code":"KeyAlreadyExists","message":"Key ` + testImportKeyID + ` already exists in data store.","region":"garage","path":"/v2/ImportKey"}`
	garage := newImportKeyGarage(t, http.StatusConflict, garageErr)

	rec := doImportKey(t, garage.URL, `{"accessKeyId":"`+testImportKeyID+`","secretAccessKey":"`+testImportSecret+`"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"code":"KeyAlreadyExists"`) {
		t.Errorf("Garage error not forwarded: %s", rec.Body.String())
	}
}

func TestValidateImportKeyAcceptsGarageRules(t *testing.T) {
	for _, req := range []importKeyRequest{
		{AccessKeyID: testImportKeyID, SecretAccessKey: testImportSecret},
		// Garage only requires >= 8 chars of [A-Za-z0-9-_.] and >= 16 graphic ASCII.
		{AccessKeyID: "AKIA-key_1.x", SecretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCY"},
	} {
		if msg := validateImportKey(req); msg != "" {
			t.Errorf("validateImportKey(%q) = %q, want ok", req.AccessKeyID, msg)
		}
	}
}

func TestAudit_ImportKeyRecordsAccessKeyIDOnly(t *testing.T) {
	garage := newImportKeyGarage(t, http.StatusOK, `{"accessKeyId":"`+testImportKeyID+`","name":"n"}`)
	handler, store := setupTestRouter(t, garage.URL)
	buf := captureLogs(t)

	body := `{"accessKeyId":"` + testImportKeyID + `","secretAccessKey":"` + testImportSecret + `","name":"n"}`
	req := authenticatedRequest(t, store, http.MethodPost, "/api/keys/import", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body %s", rec.Code, rec.Body.String())
	}
	if got, _ := garage.got(); !strings.Contains(got, testImportSecret) {
		t.Errorf("Garage did not receive the secret: %q", got)
	}
	audits := logLines(t, buf, "audit")
	if len(audits) != 1 {
		t.Fatalf("want 1 audit line:\n%s", buf.String())
	}
	detail, _ := audits[0]["detail"].(map[string]any)
	if detail["accessKeyId"] != testImportKeyID || len(detail) != 1 {
		t.Errorf("detail = %v", audits[0]["detail"])
	}
	if strings.Contains(buf.String(), testImportSecret) {
		t.Errorf("secret leaked into logs:\n%s", buf.String())
	}
}

func TestExtractImportedKeyIDSkipsSecretLikeValues(t *testing.T) {
	for _, id := range []string{
		testImportSecret, // Garage secret pasted into the ID field
		"wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", // AWS-style secret
		"0123456789abcdef0123456789abcdef0",        // 33 chars: over the cap
		"GK123",                                    // too short
		"GK0123 456789",                            // not a token
		"",
	} {
		b, _ := json.Marshal(map[string]string{"accessKeyId": id, "secretAccessKey": testImportSecret})
		if d := extractImportedKeyID(b, true); d != nil {
			t.Errorf("extractImportedKeyID(%q) = %v, want nil", id, d)
		}
	}
	for _, id := range []string{testImportKeyID, "AKIAIOSFODNN7EXAMPLE"} {
		b, _ := json.Marshal(map[string]string{"accessKeyId": id})
		if d := extractImportedKeyID(b, true); d["accessKeyId"] != id {
			t.Errorf("extractImportedKeyID(%q) = %v", id, d)
		}
	}
}
