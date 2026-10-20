package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeCluster struct {
	health       string
	healthStatus int
	status       string
	workers      string
}

const healthyBody = `{"status":"healthy","knownNodes":3,"connectedNodes":3,"storageNodes":3,"storageNodesUp":3,"partitions":256,"partitionsQuorum":256,"partitionsAllOk":256}`

// garage-1 down on 2026-10-19: 2 / 3 storage nodes, no partition fully replicated.
const degradedBody = `{"status":"degraded","knownNodes":3,"connectedNodes":2,"storageNodes":3,"storageNodesUp":2,"partitions":256,"partitionsQuorum":256,"partitionsAllOk":0}`

// Three storage nodes and one gateway (role without capacity).
const statusBody = `{"nodes":[
  {"id":"aaa","hostname":"garage-0","draining":false,"role":{"zone":"dc1","capacity":100,"tags":[]}},
  {"id":"bbb","hostname":"garage-1","draining":false,"role":{"zone":"dc1","capacity":100,"tags":[]}},
  {"id":"ccc","hostname":"garage-2","draining":false,"role":{"zone":"dc1","capacity":100,"tags":[]}},
  {"id":"ggg","hostname":"gateway","draining":false,"role":{"zone":"dc1","capacity":null,"tags":[]}}]}`

func idleWorkers() string {
	ws := `[{"id":1,"name":"object sync","state":"idle","queueLength":null},{"id":2,"name":"version sync","state":"idle"},{"id":3,"name":"block_ref sync","state":"idle"},{"id":4,"name":"object Merkle","state":"idle"},{"id":5,"name":"block_ref queue","state":"idle","queueLength":0},{"id":6,"name":"Block scrub worker","state":"busy"},{"id":7,"name":"block_ref GC","state":"idle","queueLength":39292}]`
	return `{"success":{"aaa":` + ws + `,"bbb":` + ws + `,"ccc":` + ws + `},"error":{}}`
}

func healthyCluster() fakeCluster {
	return fakeCluster{health: healthyBody, healthStatus: http.StatusOK, status: statusBody, workers: idleWorkers()}
}

// launchRepairAgainst runs a repair launch (cluster-wide or per-node) against
// a fake Garage and reports the console's status, body and whether Garage
// received the launch.
func launchRepairAgainst(t *testing.T, path, repairBody string, c fakeCluster) (int, string, bool) {
	t.Helper()
	launched := false
	mux := http.NewServeMux()
	serve := func(p, body string, status int) {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			w.Write([]byte(body))
		})
	}
	serve("/v2/GetClusterHealth", c.health, c.healthStatus)
	serve("/v2/GetClusterStatus", c.status, http.StatusOK)
	serve("/v2/ListWorkers", c.workers, http.StatusOK)
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

type guardError struct {
	Error      string   `json:"error"`
	Reasons    []string `json:"reasons"`
	Advice     string   `json:"advice"`
	RepairType string   `json:"repairType"`
}

func decodeGuardError(t *testing.T, body string) guardError {
	t.Helper()
	var got guardError
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return got
}

func TestDestructiveRepairRunsOnHealthyIdleCluster(t *testing.T) {
	for _, path := range []string{"/api/repair", "/api/nodes/aaa/repair"} {
		code, body, launched := launchRepairAgainst(t, path, `{"repairType":"blockRefs"}`, healthyCluster())
		if code != http.StatusOK || !launched {
			t.Errorf("%s: status = %d launched = %v body = %s", path, code, launched, body)
		}
	}
}

func TestDestructiveRepairRefusedWhileNodeDown(t *testing.T) {
	c := healthyCluster()
	c.health = degradedBody
	// garage-1 is down, so it does not answer ListWorkers either.
	c.workers = strings.Replace(idleWorkers(), `"bbb":[`, `"zzz":[`, 1)
	c.workers = strings.Replace(c.workers, `"error":{}`, `"error":{"bbb":"Not connected: bbb"}`, 1)
	for _, repair := range []string{"versions", "blockRefs", "blockRc", "blocks", "multipartUploads"} {
		for _, path := range []string{"/api/repair", "/api/nodes/aaa/repair"} {
			code, body, launched := launchRepairAgainst(t, path, `{"repairType":"`+repair+`"}`, c)
			if code != http.StatusConflict || launched {
				t.Errorf("%s %s: status = %d launched = %v body = %s", path, repair, code, launched, body)
				continue
			}
			got := decodeGuardError(t, body)
			if got.RepairType != repair || len(got.Reasons) != 3 ||
				got.Reasons[0] != "ストレージノードが停止中です (稼働 2 / 3)" ||
				got.Reasons[1] != "全レプリカが揃っていないパーティションがあります (256 / 256)" ||
				!strings.Contains(got.Reasons[2], "garage-1 のワーカー状態を取得できません (Not connected: bbb)") ||
				!strings.Contains(got.Advice, "tables repair") {
				t.Errorf("%s: body = %s", repair, body)
			}
		}
	}
}

// Health is back to healthy the moment a node reconnects, but its tables are
// still being synced: a sync worker busy on any storage node must still refuse.
func TestDestructiveRepairRefusedWhileTablesSyncing(t *testing.T) {
	c := healthyCluster()
	c.workers = strings.Replace(idleWorkers(), `"bbb":[{"id":1,"name":"object sync","state":"idle","queueLength":null}`, `"bbb":[{"id":1,"name":"object sync","state":"busy","progress":"12%"}`, 1)
	code, body, launched := launchRepairAgainst(t, "/api/repair", `{"repairType":"blockRefs"}`, c)
	if code != http.StatusConflict || launched {
		t.Fatalf("status = %d launched = %v body = %s", code, launched, body)
	}
	got := decodeGuardError(t, body)
	if len(got.Reasons) != 1 || got.Reasons[0] != "テーブルの同期が進行中です (garage-1: object sync が実行中)" || !strings.Contains(got.Advice, "idle になる") {
		t.Errorf("body = %s", body)
	}
}

func TestDestructiveRepairRefusedWhileInsertQueueNotEmpty(t *testing.T) {
	c := healthyCluster()
	c.workers = strings.Replace(idleWorkers(), `"ccc":[{"id":1,"name":"object sync","state":"idle","queueLength":null}`, `"ccc":[{"id":1,"name":"object sync","state":"idle"},{"id":9,"name":"version queue","state":"idle","queueLength":17}`, 1)
	code, body, launched := launchRepairAgainst(t, "/api/repair", `{"repairType":"versions"}`, c)
	if code != http.StatusConflict || launched || !strings.Contains(body, "garage-2: version queue にキュー 17 件") {
		t.Errorf("status = %d launched = %v body = %s", code, launched, body)
	}
}

// A gateway node going away must not block: only storage nodes hold metadata,
// and the gateway not answering ListWorkers is just as irrelevant.
func TestDestructiveRepairIgnoresGatewayNodes(t *testing.T) {
	c := healthyCluster()
	c.health = `{"status":"healthy","knownNodes":4,"connectedNodes":3,"storageNodes":3,"storageNodesUp":3,"partitions":256,"partitionsQuorum":256,"partitionsAllOk":256}`
	c.workers = strings.Replace(idleWorkers(), `"error":{}`, `"error":{"ggg":"Not connected: ggg"}`, 1)
	code, body, launched := launchRepairAgainst(t, "/api/repair", `{"repairType":"blocks"}`, c)
	if code != http.StatusOK || !launched {
		t.Errorf("status = %d launched = %v body = %s", code, launched, body)
	}
}

// Every node connected but a partition still missing a replica (layout
// change being applied) is still unsafe.
func TestDestructiveRepairRefusedWhilePartitionNotReplicated(t *testing.T) {
	c := healthyCluster()
	c.health = `{"status":"degraded","knownNodes":3,"connectedNodes":3,"storageNodes":3,"storageNodesUp":3,"partitions":256,"partitionsQuorum":256,"partitionsAllOk":250}`
	code, body, launched := launchRepairAgainst(t, "/api/repair", `{"repairType":"versions"}`, c)
	if code != http.StatusConflict || launched || !strings.Contains(body, "(6 / 256)") {
		t.Errorf("status = %d launched = %v body = %s", code, launched, body)
	}
}

func TestDestructiveRepairRefusedWhenHealthUnavailable(t *testing.T) {
	c := healthyCluster()
	c.health, c.healthStatus = `oops`, http.StatusInternalServerError
	code, body, launched := launchRepairAgainst(t, "/api/repair", `{"repairType":"blockRefs"}`, c)
	if code != http.StatusBadGateway || launched {
		t.Errorf("status = %d launched = %v body = %s", code, launched, body)
	}
}

// A health answer without the counters (API version skew) must refuse, not
// read the missing fields as zero and pass.
func TestDestructiveRepairRefusedWhenHealthIncomplete(t *testing.T) {
	c := healthyCluster()
	c.health = `{"status":"healthy","storageNodesOk":3}`
	code, body, launched := launchRepairAgainst(t, "/api/repair", `{"repairType":"blockRc"}`, c)
	if code != http.StatusBadGateway || launched {
		t.Errorf("status = %d launched = %v body = %s", code, launched, body)
	}
}

// Sync-only, read-only and scrub operations never consult the cluster state.
func TestNonDestructiveRepairNotGated(t *testing.T) {
	c := healthyCluster()
	c.health = degradedBody
	c.workers = `{"success":{},"error":{"aaa":"down","bbb":"down","ccc":"down"}}`
	for _, body := range []string{`{"repairType":"tables"}`, `{"repairType":"rebalance"}`, `{"repairType":"aliases"}`, `{"repairType":"clearResyncQueue"}`, `{"repairType":{"scrub":"start"}}`} {
		for _, path := range []string{"/api/repair", "/api/nodes/aaa/repair"} {
			code, resp, launched := launchRepairAgainst(t, path, body, c)
			if code != http.StatusOK || !launched {
				t.Errorf("%s %s: status = %d launched = %v body = %s", path, body, code, launched, resp)
			}
		}
	}
}

func TestDecodeRepairType(t *testing.T) {
	if name, _, _, ok := decodeRepairType([]byte(`{"repairType":"blockRc"}`)); !ok || name != "blockRc" {
		t.Errorf("string form: %q %v", name, ok)
	}
	if name, k, v, ok := decodeRepairType([]byte(`{"repairType":{"scrub":"start"}}`)); !ok || name != "" || k != "scrub" || v != "start" {
		t.Errorf("object form: %q %q %q %v", name, k, v, ok)
	}
	for _, bad := range []string{``, `{}`, `{"repairType":5}`, `{"repairType":{"a":"b","c":"d"}}`, `{"repairType":{"scrub":1}}`} {
		if _, _, _, ok := decodeRepairType([]byte(bad)); ok {
			t.Errorf("%s decoded", bad)
		}
	}
}
