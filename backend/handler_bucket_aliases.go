package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
)

// maxAliasBodyBytes bounds the tiny JSON body of POST /api/buckets/{id}/aliases.
const maxAliasBodyBytes = 4 << 10

// bucketAliasRequest is the body of POST /api/buckets/{id}/aliases:
// either {"globalAlias": "..."} or {"localAlias": "...", "accessKeyId": "..."}.
type bucketAliasRequest struct {
	GlobalAlias *string `json:"globalAlias"`
	LocalAlias  *string `json:"localAlias"`
	AccessKeyID *string `json:"accessKeyId"`
}

// garageAliasBody builds the Garage AddBucketAlias / RemoveBucketAlias body:
// a global alias when accessKeyID is nil, else a local alias in that key's
// namespace. Only the shape is checked here (non-empty names); the S3 naming
// rules are Garage's to enforce, and its error message is forwarded.
func garageAliasBody(bucketID, alias string, accessKeyID *string) ([]byte, string) {
	if strings.TrimSpace(alias) == "" {
		return nil, "alias must not be empty"
	}
	if accessKeyID == nil {
		b, _ := json.Marshal(map[string]string{"bucketId": bucketID, "globalAlias": alias})
		return b, ""
	}
	if strings.TrimSpace(*accessKeyID) == "" {
		return nil, "accessKeyId must not be empty for a local alias"
	}
	b, _ := json.Marshal(map[string]string{"bucketId": bucketID, "localAlias": alias, "accessKeyId": *accessKeyID})
	return b, ""
}

// handleAddBucketAlias serves POST /api/buckets/{id}/aliases → Garage
// AddBucketAlias, injecting the bucket ID from the URL. Garage answers with
// the updated GetBucketInfo response, forwarded as-is; the list caches are
// cleared on success because the bucket and key lists show aliases.
func handleAddBucketAlias(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req bucketAliasRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAliasBodyBytes))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			writeJSONError(w, http.StatusBadRequest, `invalid request body: expected {"globalAlias":string} or {"localAlias":string,"accessKeyId":string}`)
			return
		}
		if _, err := dec.Token(); err != io.EOF {
			writeJSONError(w, http.StatusBadRequest, "invalid request body: unexpected trailing data")
			return
		}
		if (req.GlobalAlias != nil) == (req.LocalAlias != nil) {
			writeJSONError(w, http.StatusBadRequest, "exactly one of globalAlias or localAlias is required")
			return
		}
		var alias string
		if req.GlobalAlias != nil {
			if req.AccessKeyID != nil {
				writeJSONError(w, http.StatusBadRequest, "accessKeyId is only allowed with localAlias")
				return
			}
			alias = *req.GlobalAlias
		} else {
			if req.AccessKeyID == nil {
				writeJSONError(w, http.StatusBadRequest, "accessKeyId is required with localAlias")
				return
			}
			alias = *req.LocalAlias
		}
		body, msg := garageAliasBody(chi.URLParam(r, "id"), alias, req.AccessKeyID)
		if msg != "" {
			writeJSONError(w, http.StatusBadRequest, msg)
			return
		}
		proxyGarageMutation(w, r, garageAdmin, "/v2/AddBucketAlias", bytes.NewReader(body))
	}
}

// handleRemoveBucketAlias serves DELETE /api/buckets/{id}/aliases/{alias}
// → Garage RemoveBucketAlias. Without a query it removes the global alias;
// with ?accessKeyId=GK... it removes that key's local alias. The target is
// in the URL (like DELETE /api/buckets/{id}/keys/{kid}) since DELETE bodies
// can be dropped by proxies. Garage refuses to remove a bucket's last alias.
func handleRemoveBucketAlias(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		alias := chi.URLParam(r, "alias")
		// chi matches on the escaped path when the URL needed escaping, so
		// the parameter is still percent-encoded in that case.
		if r.URL.RawPath != "" {
			unescaped, err := url.PathUnescape(alias)
			if err != nil {
				writeJSONError(w, http.StatusBadRequest, "invalid alias in path")
				return
			}
			alias = unescaped
		}
		var accessKeyID *string
		if q := r.URL.Query(); q.Has("accessKeyId") {
			v := q.Get("accessKeyId")
			accessKeyID = &v
		}
		body, msg := garageAliasBody(chi.URLParam(r, "id"), alias, accessKeyID)
		if msg != "" {
			writeJSONError(w, http.StatusBadRequest, msg)
			return
		}
		proxyGarageMutation(w, r, garageAdmin, "/v2/RemoveBucketAlias", bytes.NewReader(body))
	}
}
