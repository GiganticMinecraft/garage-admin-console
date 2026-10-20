package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// destructiveRepairs are the LaunchRepairOperation repairTypes that mark
// metadata as deleted or delete block files. They decide "this version /
// block_ref has no parent" by looking the parent up on the nodes holding it;
// while a storage node is disconnected that lookup cannot reach a quorum and
// a live parent can be reported as missing. On 2026-10-19 a blockRefs repair
// ran while garage-1 was disconnected: 553 live block_refs were marked
// deleted (143 quorum errors), their blocks were garbage-collected minutes
// later and about 70 objects became unreadable. These repairs are therefore
// refused unless every storage node is up and every partition has all of its
// replicas. The check lives here, at the single chokepoint every client
// (UI, per-node page, scripts) goes through, rather than only in the UI.
var destructiveRepairs = map[string]bool{
	"versions":         true,
	"blockRefs":        true,
	"blockRc":          true,
	"blocks":           true,
	"multipartUploads": true,
}

// repairTypeName returns the string repairType of a LaunchRepairOperation body,
// or "" when it is an object form ({"scrub": ...}) or malformed. Garage keeps
// validating the body itself; this only needs to recognise the gated names.
func repairTypeName(body []byte) string {
	var req struct {
		RepairType json.RawMessage `json:"repairType"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return ""
	}
	var name string
	if err := json.Unmarshal(req.RepairType, &name); err != nil {
		return ""
	}
	return name
}

// clusterHealth is the subset of Garage's GetClusterHealth the guard reads.
type clusterHealth struct {
	Status          string `json:"status"`
	StorageNodes    int    `json:"storageNodes"`
	StorageNodesUp  int    `json:"storageNodesUp"`
	Partitions      int    `json:"partitions"`
	PartitionsAllOk int    `json:"partitionsAllOk"`
}

// destructiveRepairBlockers returns why a destructive repair must not run on
// this cluster health, or nil when it may. Only storage nodes matter: gateway
// nodes hold no metadata and cannot cause a false "not found".
func destructiveRepairBlockers(h clusterHealth) []string {
	var reasons []string
	if h.StorageNodesUp < h.StorageNodes {
		reasons = append(reasons, fmt.Sprintf("ストレージノードが停止中です (稼働 %d / %d)", h.StorageNodesUp, h.StorageNodes))
	}
	if h.PartitionsAllOk < h.Partitions {
		reasons = append(reasons, fmt.Sprintf("全レプリカが揃っていないパーティションがあります (%d / %d)", h.Partitions-h.PartitionsAllOk, h.Partitions))
	}
	return reasons
}

// guardDestructiveRepair reads the repair body and, for a destructive
// repairType, fetches the live cluster health and refuses the launch with
// 409 Conflict (body: {"error": ..., "reasons": [...]}) unless the cluster is
// fully connected and fully replicated. An unreadable health answer also
// refuses (502): waiting a refresh costs nothing, a wrong "not found" costs data.
// Returns true when the caller may forward the request to Garage.
func guardDestructiveRepair(ctx context.Context, w http.ResponseWriter, garageAdmin *GarageAdminClient, body []byte) bool {
	name := repairTypeName(body)
	if !destructiveRepairs[name] {
		return true
	}
	resp, err := garageAdmin.doRequest(ctx, http.MethodGet, "/v2/GetClusterHealth", nil)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "クラスタの状態を取得できないため、"+name+" を安全に実行できるか判断できません")
		return false
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var h clusterHealth
	if err != nil || resp.StatusCode != http.StatusOK || json.Unmarshal(raw, &h) != nil {
		writeJSONError(w, http.StatusBadGateway, "クラスタの状態を取得できないため、"+name+" を安全に実行できるか判断できません")
		return false
	}
	reasons := destructiveRepairBlockers(h)
	if len(reasons) == 0 {
		return true
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusConflict)
	msg := name + " は全ストレージノードが稼働し全パーティションのレプリカが揃うまで実行できません。先に tables repair で同期を終えてください"
	for _, r := range reasons {
		msg += "。" + r
	}
	json.NewEncoder(w).Encode(map[string]any{"error": msg, "reasons": reasons, "repairType": name})
	return false
}
