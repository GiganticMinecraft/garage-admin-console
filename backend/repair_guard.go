package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

// destructiveRepairs are the LaunchRepairOperation repairTypes that mark
// metadata as deleted or delete block files. They decide "this version /
// block_ref has no parent" by looking the parent up on the storage nodes
// holding it; while one is disconnected, or still receiving table entries
// after reconnecting, that lookup can be answered by a replica that does not
// have the row yet (RF=2 reads need one answer) and a live parent is reported
// as missing. On 2026-10-19 a blockRefs repair ran while garage-1 was
// disconnected: 553 live block_refs were marked deleted (143 quorum errors),
// their blocks were garbage-collected minutes later and about 70 objects
// became unreadable. These repairs are therefore refused unless every storage
// node is up, every partition has all of its replicas and no table sync /
// Merkle / insert worker is busy on any storage node. The check lives here,
// at the single chokepoint every client (UI, per-node page, scripts) goes
// through, rather than only in the UI.
var destructiveRepairs = map[string]bool{
	"versions":         true,
	"blockRefs":        true,
	"blockRc":          true,
	"blocks":           true,
	"multipartUploads": true,
}

// tableSyncWorkers are the workers whose activity means the metadata tables
// the destructive repairs consult are still converging: a full sync in
// progress (after a reconnection or a tables repair), Merkle tree updates
// pending, or inserts queued.
var tableSyncWorkers = map[string]bool{
	"object sync": true, "version sync": true, "block_ref sync": true,
	"object Merkle": true, "version Merkle": true, "block_ref Merkle": true,
	"object queue": true, "version queue": true, "block_ref queue": true,
}

// decodeRepairType parses a LaunchRepairOperation body. Garage's RepairType
// is either a plain string ("blockRc") or a one-key object ({"scrub":
// "start"}); the string form comes back as name, the object form as
// objKey/objValue. ok is false for anything else. Shared with the audit log so
// the guard and the log cannot disagree on which repair was requested.
func decodeRepairType(body []byte) (name, objKey, objValue string, ok bool) {
	var req struct {
		RepairType json.RawMessage `json:"repairType"`
	}
	if json.Unmarshal(body, &req) != nil || len(req.RepairType) == 0 {
		return "", "", "", false
	}
	if json.Unmarshal(req.RepairType, &name) == nil {
		return name, "", "", true
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(req.RepairType, &obj) != nil || len(obj) != 1 {
		return "", "", "", false
	}
	for k, v := range obj {
		if json.Unmarshal(v, &objValue) != nil {
			return "", "", "", false
		}
		return "", k, objValue, true
	}
	return "", "", "", false
}

// clusterHealth is the subset of Garage's GetClusterHealth the guard reads.
// Pointers: a counter missing from the answer (API version skew) must refuse,
// not read as zero and pass.
type clusterHealth struct {
	StorageNodes    *int `json:"storageNodes"`
	StorageNodesUp  *int `json:"storageNodesUp"`
	Partitions      *int `json:"partitions"`
	PartitionsAllOk *int `json:"partitionsAllOk"`
}

func (h clusterHealth) complete() bool {
	return h.StorageNodes != nil && h.StorageNodesUp != nil && h.Partitions != nil && h.PartitionsAllOk != nil
}

// clusterStatusNodes is the subset of GetClusterStatus the guard reads: which
// nodes hold metadata (a role with capacity, or draining out of the layout).
type clusterStatusNodes struct {
	Nodes []struct {
		ID       string `json:"id"`
		Hostname string `json:"hostname"`
		Draining bool   `json:"draining"`
		Role     *struct {
			Capacity *int64 `json:"capacity"`
		} `json:"role"`
	} `json:"nodes"`
}

type storageNode struct{ id, name string }

func (s clusterStatusNodes) storageNodes() []storageNode {
	var out []storageNode
	for _, n := range s.Nodes {
		isStorage := n.Draining
		if n.Role != nil {
			isStorage = n.Role.Capacity != nil
		}
		if !isStorage {
			continue
		}
		name := n.Hostname
		if name == "" {
			name = n.ID
			if len(name) > 16 {
				name = name[:16] + "…"
			}
		}
		out = append(out, storageNode{id: n.ID, name: name})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].id < out[j].id })
	return out
}

// workerStatus is the subset of a ListWorkers entry the guard reads.
type workerStatus struct {
	Name        string          `json:"name"`
	State       json.RawMessage `json:"state"`
	QueueLength *int64          `json:"queueLength"`
}

func (w workerStatus) idle() bool {
	var s string
	return json.Unmarshal(w.State, &s) == nil && s == "idle"
}

// repairGuardVerdict is the outcome of the health checks: reasons the repair
// must not run (empty when it may) and what the operator should do about it.
type repairGuardVerdict struct {
	Reasons []string
	Advice  string
}

// destructiveRepairBlockers returns why a destructive repair must not run on
// this cluster state, or an empty verdict when it may. Only storage nodes
// matter: gateway nodes hold no metadata and cannot cause a false "not found".
func destructiveRepairBlockers(h clusterHealth, nodes []storageNode, workers listWorkersMulti) repairGuardVerdict {
	var v repairGuardVerdict
	if *h.StorageNodesUp < *h.StorageNodes {
		v.Reasons = append(v.Reasons, fmt.Sprintf("ストレージノードが停止中です (稼働 %d / %d)", *h.StorageNodesUp, *h.StorageNodes))
	}
	if *h.PartitionsAllOk < *h.Partitions {
		v.Reasons = append(v.Reasons, fmt.Sprintf("全レプリカが揃っていないパーティションがあります (%d / %d)", *h.Partitions-*h.PartitionsAllOk, *h.Partitions))
	}
	degraded := len(v.Reasons) > 0
	var syncing []string
	for _, n := range nodes {
		raw, answered := workers.Success[n.id]
		if !answered {
			msg := workers.Error[n.id]
			if msg == "" {
				msg = "no answer"
			}
			v.Reasons = append(v.Reasons, fmt.Sprintf("%s のワーカー状態を取得できません (%s)", n.name, msg))
			continue
		}
		for _, r := range raw {
			var w workerStatus
			if json.Unmarshal(r, &w) != nil || !tableSyncWorkers[w.Name] {
				continue
			}
			if !w.idle() {
				syncing = append(syncing, n.name+": "+w.Name+" が実行中")
			} else if w.QueueLength != nil && *w.QueueLength > 0 {
				syncing = append(syncing, fmt.Sprintf("%s: %s にキュー %d 件", n.name, w.Name, *w.QueueLength))
			}
		}
	}
	if len(syncing) > 0 {
		v.Reasons = append(v.Reasons, "テーブルの同期が進行中です ("+strings.Join(syncing, "、")+")")
	}
	switch {
	case degraded:
		v.Advice = "ストレージノードの復旧を待ち、その後 tables repair で同期を終えてから実行してください"
	case len(v.Reasons) > 0:
		v.Advice = "同期が終わる (sync / Merkle / queue ワーカーが idle になる) まで待ってから実行してください"
	}
	return v
}

// guardDestructiveRepair reads the repair body and, for a destructive
// repairType, fetches the live cluster health, node roles and worker states
// and refuses the launch with 409 Conflict (body: {"error", "reasons",
// "advice", "repairType"}) unless the cluster is fully connected, fully
// replicated and not syncing tables. An unreadable answer also refuses (502):
// waiting a refresh costs nothing, a wrong "not found" costs data.
// Returns true when the caller may forward the request to Garage.
func guardDestructiveRepair(ctx context.Context, w http.ResponseWriter, garageAdmin *GarageAdminClient, body []byte) bool {
	name, _, _, _ := decodeRepairType(body)
	if !destructiveRepairs[name] {
		return true
	}
	unknown := func(what string) bool {
		writeJSONError(w, http.StatusBadGateway, what+"を取得できないため、"+name+" を安全に実行できるか判断できません")
		return false
	}
	var h clusterHealth
	if err := garageRequestJSON(ctx, garageAdmin, http.MethodGet, "/v2/GetClusterHealth", nil, &h); err != nil || !h.complete() {
		return unknown("クラスタの状態")
	}
	var status clusterStatusNodes
	if err := garageRequestJSON(ctx, garageAdmin, http.MethodGet, "/v2/GetClusterStatus", nil, &status); err != nil {
		return unknown("ノードの役割")
	}
	var workers listWorkersMulti
	if err := garageRequestJSON(ctx, garageAdmin, http.MethodPost, "/v2/ListWorkers?node=*", []byte(`{}`), &workers); err != nil {
		return unknown("ワーカーの状態")
	}
	v := destructiveRepairBlockers(h, status.storageNodes(), workers)
	if len(v.Reasons) == 0 {
		return true
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusConflict)
	msg := name + " は実行できません: " + strings.Join(v.Reasons, "。") + "。" + v.Advice
	json.NewEncoder(w).Encode(map[string]any{"error": msg, "reasons": v.Reasons, "advice": v.Advice, "repairType": name})
	return false
}
