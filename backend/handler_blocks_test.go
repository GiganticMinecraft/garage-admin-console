package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type blockErrorsWire struct {
	Items        []map[string]any  `json:"items"`
	CheckedNodes []string          `json:"checkedNodes"`
	NodeErrors   map[string]string `json:"nodeErrors"`
}

// fetchBlockErrors runs GET /api/blocks/errors against a fake Garage that
// answers ListBlockErrors with garageBody.
func fetchBlockErrors(t *testing.T, garageBody string) blockErrorsWire {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/ListBlockErrors", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("node") != "*" {
			t.Errorf("node param = %q, want *", r.URL.Query().Get("node"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(garageBody))
	})
	garage := httptest.NewServer(mux)
	defer garage.Close()
	handler, store := setupTestRouter(t, garage.URL)

	req := authenticatedRequest(t, store, http.MethodGet, "/api/blocks/errors", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got blockErrorsWire
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	if got.Items == nil || got.CheckedNodes == nil || got.NodeErrors == nil {
		t.Fatalf("items, checkedNodes and nodeErrors must always be present: %s", rec.Body.String())
	}
	return got
}

func blockErr(hash string) string {
	return `{"blockHash":"` + hash + `","refcount":1,"errorCount":2,"lastTrySecsAgo":3,"nextTryInSecs":4}`
}

func TestListBlockErrorsAllNodesAnswer(t *testing.T) {
	got := fetchBlockErrors(t, `{"success":{"bbb":[`+blockErr("h2")+`],"aaa":[`+blockErr("h1")+`],"ccc":[]},"error":{}}`)
	if len(got.NodeErrors) != 0 {
		t.Errorf("nodeErrors = %v, want empty", got.NodeErrors)
	}
	if len(got.Items) != 2 {
		t.Fatalf("items = %v", got.Items)
	}
	// Sorted by node ID, tagged with nodeId, Garage fields kept.
	if got.Items[0]["nodeId"] != "aaa" || got.Items[0]["blockHash"] != "h1" ||
		got.Items[1]["nodeId"] != "bbb" || got.Items[1]["blockHash"] != "h2" {
		t.Errorf("items = %v", got.Items)
	}
	if got.Items[0]["errorCount"] != float64(2) {
		t.Errorf("errorCount lost: %v", got.Items[0])
	}
	// A node with no block errors still counts as checked.
	if strings.Join(got.CheckedNodes, ",") != "aaa,bbb,ccc" {
		t.Errorf("checkedNodes = %v", got.CheckedNodes)
	}
}

// An empty MultiResponse observed nothing: no checked node, so the UI must
// not read it as "no block errors".
func TestListBlockErrorsNoNodes(t *testing.T) {
	got := fetchBlockErrors(t, `{"success":{},"error":{}}`)
	if len(got.Items) != 0 || len(got.CheckedNodes) != 0 || len(got.NodeErrors) != 0 {
		t.Errorf("got %+v", got)
	}
}

// An entry that cannot be decoded marks its node unchecked instead of
// vanishing; the node's readable entries are kept.
func TestListBlockErrorsUnreadableEntry(t *testing.T) {
	got := fetchBlockErrors(t, `{"success":{"aaa":[`+blockErr("h1")+`,"garbage",null],"bbb":[]},"error":{}}`)
	if len(got.Items) != 1 || got.Items[0]["blockHash"] != "h1" {
		t.Errorf("items = %v", got.Items)
	}
	if got.NodeErrors["aaa"] != blockErrorUnreadableMsg {
		t.Errorf("nodeErrors = %v", got.NodeErrors)
	}
	if strings.Join(got.CheckedNodes, ",") != "bbb" {
		t.Errorf("checkedNodes = %v", got.CheckedNodes)
	}
}

func TestListBlockErrorsPartialFailure(t *testing.T) {
	got := fetchBlockErrors(t, `{"success":{"aaa":[`+blockErr("h1")+`]},"error":{"bbb":"Not connected: bbb"}}`)
	if len(got.Items) != 1 || got.Items[0]["nodeId"] != "aaa" {
		t.Errorf("items = %v", got.Items)
	}
	if got.NodeErrors["bbb"] != "Not connected: bbb" || len(got.NodeErrors) != 1 {
		t.Errorf("nodeErrors = %v", got.NodeErrors)
	}
	if strings.Join(got.CheckedNodes, ",") != "aaa" {
		t.Errorf("checkedNodes = %v", got.CheckedNodes)
	}
}

// Every node failing must not look like "no block errors".
func TestListBlockErrorsAllNodesFail(t *testing.T) {
	got := fetchBlockErrors(t, `{"success":{},"error":{"aaa":"Not connected","bbb":"Not connected","ccc":"timeout"}}`)
	if len(got.Items) != 0 {
		t.Errorf("items = %v, want empty", got.Items)
	}
	if len(got.NodeErrors) != 3 || got.NodeErrors["ccc"] != "timeout" {
		t.Errorf("nodeErrors = %v", got.NodeErrors)
	}
	if len(got.CheckedNodes) != 0 {
		t.Errorf("checkedNodes = %v, want empty", got.CheckedNodes)
	}
}
