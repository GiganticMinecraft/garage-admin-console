package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// launchRepairAgainst runs a repair launch (cluster-wide or per-node) against
// a fake Garage whose GetClusterHealth answers healthBody, and reports the
// console's status, body and whether Garage received the launch.
func launchRepairAgainst(t *testing.T, path, repairBody, healthBody string, healthStatus int) (int, string, bool) {
	t.Helper()
	launched := false
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/GetClusterHealth", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(healthStatus)
		w.Write([]byte(healthBody))
	})
	mux.HandleFunc("/v2/LaunchRepairOperation", func(w http.ResponseWriter, r *http.Request) {
		launched = true
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success":{"aaa":null},"error":{}}`))
	})
	garage := httptest.NewServer(mux)
	defer garage.Close()
	handler, store := setupTestRouter(t, garage.URL)

	req := authenticatedRequest(t, store, http.MethodPost, path, strings.NewReader(repairBody))
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String(), launched
}

const healthyBody = `{"status":"healthy","knownNodes":3,"connectedNodes":3,"storageNodes":3,"storageNodesUp":3,"partitions":256,"partitionsQuorum":256,"partitionsAllOk":256}`

// garage-1 down on 2026-10-19: 2 / 3 storage nodes, no partition fully replicated.
const degradedBody = `{"status":"degraded","knownNodes":3,"connectedNodes":2,"storageNodes":3,"storageNodesUp":2,"partitions":256,"partitionsQuorum":256,"partitionsAllOk":0}`

func TestDestructiveRepairRunsOnHealthyCluster(t *testing.T) {
	for _, path := range []string{"/api/repair", "/api/nodes/aaa/repair"} {
		code, body, launched := launchRepairAgainst(t, path, `{"repairType":"blockRefs"}`, healthyBody, http.StatusOK)
		if code != http.StatusOK || !launched {
			t.Errorf("%s: status = %d launched = %v body = %s", path, code, launched, body)
		}
	}
}

func TestDestructiveRepairRefusedWhileNodeDown(t *testing.T) {
	for _, repair := range []string{"versions", "blockRefs", "blockRc", "blocks", "multipartUploads"} {
		for _, path := range []string{"/api/repair", "/api/nodes/aaa/repair"} {
			code, body, launched := launchRepairAgainst(t, path, `{"repairType":"`+repair+`"}`, degradedBody, http.StatusOK)
			if code != http.StatusConflict || launched {
				t.Errorf("%s %s: status = %d launched = %v body = %s", path, repair, code, launched, body)
				continue
			}
			var got struct {
				Error      string   `json:"error"`
				Reasons    []string `json:"reasons"`
				RepairType string   `json:"repairType"`
			}
			if err := json.Unmarshal([]byte(body), &got); err != nil {
				t.Fatalf("decode %s: %v", body, err)
			}
			if got.RepairType != repair || len(got.Reasons) != 2 || !strings.Contains(got.Error, "tables repair") {
				t.Errorf("%s: body = %s", repair, body)
			}
		}
	}
}

// A gateway node going away must not block: only storage nodes hold metadata.
func TestDestructiveRepairIgnoresGatewayNodes(t *testing.T) {
	gatewayDown := `{"status":"healthy","knownNodes":4,"connectedNodes":3,"storageNodes":3,"storageNodesUp":3,"partitions":256,"partitionsQuorum":256,"partitionsAllOk":256}`
	code, body, launched := launchRepairAgainst(t, "/api/repair", `{"repairType":"blocks"}`, gatewayDown, http.StatusOK)
	if code != http.StatusOK || !launched {
		t.Errorf("status = %d launched = %v body = %s", code, launched, body)
	}
}

// Every node connected but a partition still missing a replica (layout
// transition, resync in progress) is still unsafe.
func TestDestructiveRepairRefusedWhilePartitionNotReplicated(t *testing.T) {
	partial := `{"status":"degraded","knownNodes":3,"connectedNodes":3,"storageNodes":3,"storageNodesUp":3,"partitions":256,"partitionsQuorum":256,"partitionsAllOk":250}`
	code, body, launched := launchRepairAgainst(t, "/api/repair", `{"repairType":"versions"}`, partial, http.StatusOK)
	if code != http.StatusConflict || launched || !strings.Contains(body, "(6 / 256)") {
		t.Errorf("status = %d launched = %v body = %s", code, launched, body)
	}
}

func TestDestructiveRepairRefusedWhenHealthUnavailable(t *testing.T) {
	code, body, launched := launchRepairAgainst(t, "/api/repair", `{"repairType":"blockRefs"}`, `oops`, http.StatusInternalServerError)
	if code != http.StatusBadGateway || launched {
		t.Errorf("status = %d launched = %v body = %s", code, launched, body)
	}
}

// Sync-only, read-only and scrub operations never consult the health.
func TestNonDestructiveRepairNotGated(t *testing.T) {
	for _, body := range []string{`{"repairType":"tables"}`, `{"repairType":"rebalance"}`, `{"repairType":"aliases"}`, `{"repairType":"clearResyncQueue"}`, `{"repairType":{"scrub":"start"}}`} {
		for _, path := range []string{"/api/repair", "/api/nodes/aaa/repair"} {
			code, resp, launched := launchRepairAgainst(t, path, body, degradedBody, http.StatusOK)
			if code != http.StatusOK || !launched {
				t.Errorf("%s %s: status = %d launched = %v body = %s", path, body, code, launched, resp)
			}
		}
	}
}

func TestDestructiveRepairBlockersMessages(t *testing.T) {
	got := destructiveRepairBlockers(clusterHealth{StorageNodes: 3, StorageNodesUp: 2, Partitions: 256, PartitionsAllOk: 0})
	if len(got) != 2 || got[0] != "ストレージノードが停止中です (稼働 2 / 3)" || got[1] != "全レプリカが揃っていないパーティションがあります (256 / 256)" {
		t.Errorf("got %q", got)
	}
	if got := destructiveRepairBlockers(clusterHealth{StorageNodes: 3, StorageNodesUp: 3, Partitions: 256, PartitionsAllOk: 256}); got != nil {
		t.Errorf("healthy cluster blocked: %q", got)
	}
}
