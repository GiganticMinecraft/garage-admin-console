package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
)

// ---- Buckets ----

// bucketLocalAlias is a per-key alias of a bucket.
type bucketLocalAlias struct {
	AccessKeyID string `json:"accessKeyId"`
	Alias       string `json:"alias"`
}

// bucketQuotas mirrors Garage's ApiBucketQuotas.
type bucketQuotas struct {
	MaxSize    *uint64 `json:"maxSize"`
	MaxObjects *uint64 `json:"maxObjects"`
}

// garageBucketInfo is the subset of Garage's GetBucketInfoResponse the list uses.
type garageBucketInfo struct {
	ID            string   `json:"id"`
	Created       *string  `json:"created"`
	GlobalAliases []string `json:"globalAliases"`
	Keys          []struct {
		AccessKeyID        string   `json:"accessKeyId"`
		BucketLocalAliases []string `json:"bucketLocalAliases"`
	} `json:"keys"`
	Objects                    int64        `json:"objects"`
	Bytes                      int64        `json:"bytes"`
	UnfinishedMultipartUploads int64        `json:"unfinishedMultipartUploads"`
	Quotas                     bucketQuotas `json:"quotas"`
}

// garageBucketListItem mirrors Garage's ListBucketsResponseItem.
type garageBucketListItem struct {
	ID            string             `json:"id"`
	Created       *string            `json:"created"`
	GlobalAliases []string           `json:"globalAliases"`
	LocalAliases  []bucketLocalAlias `json:"localAliases"`
}

// bucketListItem is one row of GET /api/buckets. The stats are null when
// Garage could not be asked for this bucket's info.
type bucketListItem struct {
	ID                         string             `json:"id"`
	GlobalAliases              []string           `json:"globalAliases"`
	LocalAliases               []bucketLocalAlias `json:"localAliases"`
	Created                    *string            `json:"created"`
	Objects                    *int64             `json:"objects"`
	Bytes                      *int64             `json:"bytes"`
	UnfinishedMultipartUploads *int64             `json:"unfinishedMultipartUploads"`
	KeyCount                   *int               `json:"keyCount"`
	Quotas                     *bucketQuotas      `json:"quotas"`
}

// withInfo fills the stats of item from Garage's bucket info (nil = unknown).
func (item *bucketListItem) withInfo(info *garageBucketInfo) {
	if item.GlobalAliases == nil {
		item.GlobalAliases = []string{}
	}
	if item.LocalAliases == nil {
		item.LocalAliases = []bucketLocalAlias{}
	}
	if info == nil {
		return
	}
	item.Objects = &info.Objects
	item.Bytes = &info.Bytes
	item.UnfinishedMultipartUploads = &info.UnfinishedMultipartUploads
	n := len(info.Keys)
	item.KeyCount = &n
	q := info.Quotas
	item.Quotas = &q
	if item.Created == nil {
		item.Created = info.Created
	}
}

// bucketItemFromInfo builds a list row from a ListBucketsInfo entry. Local
// aliases are not top-level in GetBucketInfoResponse; they hang off each key.
func bucketItemFromInfo(info *garageBucketInfo) bucketListItem {
	item := bucketListItem{ID: info.ID, GlobalAliases: info.GlobalAliases}
	for _, k := range info.Keys {
		for _, a := range k.BucketLocalAliases {
			item.LocalAliases = append(item.LocalAliases, bucketLocalAlias{AccessKeyID: k.AccessKeyID, Alias: a})
		}
	}
	item.withInfo(info)
	return item
}

// handleListBuckets serves GET /api/buckets: every bucket with its usage, key
// count and quotas, as {"items": [...], "truncated": bool}. It uses
// ListBucketsInfo when Garage has it (>= v2.5) and otherwise falls back to
// ListBuckets plus concurrent, cached GetBucketInfo calls.
func handleListBuckets(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		infos, truncated, err := listAllInfo(ctx, garageAdmin, "/v2/ListBucketsInfo", func(b garageBucketInfo) string { return b.ID })
		if err == nil {
			items := make([]bucketListItem, len(infos))
			for i := range infos {
				items[i] = bucketItemFromInfo(&infos[i])
			}
			writeListJSON(w, items, truncated)
			return
		}
		if !isUnknownEndpoint(err) {
			writeListError(w, r, err)
			return
		}

		var list []garageBucketListItem
		if err := garageGetJSON(ctx, garageAdmin, "/v2/ListBuckets", &list); err != nil {
			writeListError(w, r, err)
			return
		}
		ids := make([]string, len(list))
		for i, b := range list {
			ids[i] = b.ID
		}
		details := fetchInfoConcurrently(ctx, &bucketInfoCache, garageAdmin.baseURL+"\x00", ids,
			func(ctx context.Context, id string) (garageBucketInfo, error) {
				var info garageBucketInfo
				err := garageGetJSON(ctx, garageAdmin, "/v2/GetBucketInfo?id="+url.QueryEscape(id), &info)
				return info, err
			})
		if ctx.Err() != nil {
			return
		}

		items := make([]bucketListItem, len(list))
		for i, b := range list {
			items[i] = bucketListItem{ID: b.ID, GlobalAliases: b.GlobalAliases, LocalAliases: b.LocalAliases, Created: b.Created}
			items[i].withInfo(details[i])
		}
		writeListJSON(w, items, len(list) >= legacyListLimit)
	}
}

// ---- Keys ----

// garageKeyInfo is the subset of Garage's GetKeyInfoResponse the list uses.
// The secret is never requested and never decoded.
type garageKeyInfo struct {
	AccessKeyID string            `json:"accessKeyId"`
	Name        string            `json:"name"`
	Created     *string           `json:"created"`
	Expiration  *string           `json:"expiration"`
	Expired     bool              `json:"expired"`
	Buckets     []json.RawMessage `json:"buckets"`
}

// garageKeyListItem mirrors Garage's ListKeysResponseItem.
type garageKeyListItem struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Created    *string `json:"created"`
	Expiration *string `json:"expiration"`
	Expired    bool    `json:"expired"`
}

// keyListItem is one row of GET /api/keys. bucketCount is null when Garage
// could not be asked for this key's info.
type keyListItem struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Created     *string `json:"created"`
	Expiration  *string `json:"expiration"`
	Expired     bool    `json:"expired"`
	BucketCount *int    `json:"bucketCount"`
}

// handleListKeys serves GET /api/keys: every access key with its expiration
// and number of accessible buckets, as {"items": [...], "truncated": bool}.
// It uses ListKeysInfo when Garage has it (>= v2.5) and otherwise falls back
// to ListKeys plus concurrent, cached GetKeyInfo calls (without the secret).
func handleListKeys(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		infos, truncated, err := listAllInfo(ctx, garageAdmin, "/v2/ListKeysInfo", func(k garageKeyInfo) string { return k.AccessKeyID })
		if err == nil {
			items := make([]keyListItem, len(infos))
			for i, k := range infos {
				n := len(k.Buckets)
				items[i] = keyListItem{ID: k.AccessKeyID, Name: k.Name, Created: k.Created, Expiration: k.Expiration, Expired: k.Expired, BucketCount: &n}
			}
			writeListJSON(w, items, truncated)
			return
		}
		if !isUnknownEndpoint(err) {
			writeListError(w, r, err)
			return
		}

		var list []garageKeyListItem
		if err := garageGetJSON(ctx, garageAdmin, "/v2/ListKeys", &list); err != nil {
			writeListError(w, r, err)
			return
		}
		ids := make([]string, len(list))
		for i, k := range list {
			ids[i] = k.ID
		}
		details := fetchInfoConcurrently(ctx, &keyInfoCache, garageAdmin.baseURL+"\x00", ids,
			func(ctx context.Context, id string) (garageKeyInfo, error) {
				var info garageKeyInfo
				err := garageGetJSON(ctx, garageAdmin, "/v2/GetKeyInfo?id="+url.QueryEscape(id), &info)
				return info, err
			})
		if ctx.Err() != nil {
			return
		}

		items := make([]keyListItem, len(list))
		for i, k := range list {
			items[i] = keyListItem{ID: k.ID, Name: k.Name, Created: k.Created, Expiration: k.Expiration, Expired: k.Expired}
			if d := details[i]; d != nil {
				n := len(d.Buckets)
				items[i].BucketCount = &n
			}
		}
		writeListJSON(w, items, len(list) >= legacyListLimit)
	}
}
