package main

import (
	"net/http"
	"slices"
)

// consoleScope lists every Garage Admin API v2 endpoint this console's
// backend calls (the names after /v2/), sorted. It is the scope an admin token
// needs for every console feature to work. TestConsoleScopeMatchesSource keeps
// it in sync with the "/v2/<Name>" literals in the backend sources, so adding
// a Garage call without listing it here fails the tests.
//
// It includes CreateAdminToken and UpdateAdminToken because the admin token
// pages call them; a token allowed those can mint a "*" token, so the
// frontend's 「コンソール用スコープ」 preset leaves them out.
var consoleScope = []string{
	"AddBucketAlias",
	"AllowBucketKey",
	"ApplyClusterLayout",
	"CleanupIncompleteUploads",
	"ClusterLayoutSkipDeadNodes",
	"ConnectClusterNodes",
	"CreateAdminToken",
	"CreateBucket",
	"CreateKey",
	"CreateMetadataSnapshot",
	"DeleteAdminToken",
	"DeleteBucket",
	"DeleteKey",
	"DenyBucketKey",
	"GetAdminTokenInfo",
	"GetBlockInfo",
	"GetBucketInfo",
	"GetClusterHealth",
	"GetClusterLayout",
	"GetClusterLayoutHistory",
	"GetClusterStatistics",
	"GetClusterStatus",
	"GetCurrentAdminTokenInfo",
	"GetKeyInfo",
	"GetNodeInfo",
	"GetNodeStatistics",
	"GetWorkerVariable",
	"InspectObject",
	"LaunchRepairOperation",
	"ListAdminTokens",
	"ListBlockErrors",
	"ListBuckets",
	"ListBucketsInfo",
	"ListKeys",
	"ListKeysInfo",
	"ListWorkers",
	"PreviewClusterLayoutChanges",
	"PurgeBlocks",
	"RemoveBucketAlias",
	"RetryBlockResync",
	"RevertClusterLayout",
	"SetWorkerVariable",
	"UpdateAdminToken",
	"UpdateBucket",
	"UpdateClusterLayout",
	"UpdateKey",
}

// handleConsoleScope serves GET /api/admin-tokens/console-scope: the sorted
// list of endpoints the console needs (see consoleScope). It does not call Garage.
func handleConsoleScope() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, slices.Clone(consoleScope))
	}
}
