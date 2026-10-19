package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

// maxAliasBodyBytes bounds the tiny JSON body of the alias endpoints.
const maxAliasBodyBytes = 4 << 10

// bucketAliasRequest is the body of POST / DELETE /api/buckets/{id}/aliases:
// either {"globalAlias": "..."} or {"localAlias": "...", "accessKeyId": "..."}.
type bucketAliasRequest struct {
	GlobalAlias *string `json:"globalAlias"`
	LocalAlias  *string `json:"localAlias"`
	AccessKeyID *string `json:"accessKeyId"`
}

// isValidBucketAlias mirrors Garage's is_valid_bucket_name (S3 bucket naming
// rules), which Garage applies to both global and local aliases. Punycode
// labels are left for Garage to judge since that depends on its
// allow_punycode setting.
func isValidBucketAlias(n string) bool {
	if len(n) < 3 || len(n) > 63 {
		return false
	}
	for _, c := range n {
		if c != '.' && c != '-' && (c < 'a' || c > 'z') && (c < '0' || c > '9') {
			return false
		}
	}
	if strings.HasPrefix(n, "-") || strings.HasPrefix(n, ".") || strings.HasSuffix(n, "-") || strings.HasSuffix(n, ".") {
		return false
	}
	if net.ParseIP(n) != nil {
		return false
	}
	return !strings.HasSuffix(n, "-s3alias")
}

const invalidAliasMessage = "alias must be 3-63 characters of lowercase letters, digits, '-' and '.', start and end with a letter or digit, not look like an IP address and not end with -s3alias"

// garageBody validates the request and builds the Garage AddBucketAlias /
// RemoveBucketAlias body. strict applies the S3 naming rules (adding);
// removal only needs a non-empty name so that an alias created under other
// rules (e.g. punycode) can still be removed. It returns a client error
// message when the request is invalid.
func (req bucketAliasRequest) garageBody(bucketID string, strict bool) (map[string]any, string) {
	hasGlobal := req.GlobalAlias != nil
	if hasGlobal == (req.LocalAlias != nil) {
		return nil, "exactly one of globalAlias or localAlias is required"
	}
	var alias string
	if hasGlobal {
		if req.AccessKeyID != nil {
			return nil, "accessKeyId is only allowed with localAlias"
		}
		alias = *req.GlobalAlias
	} else {
		alias = *req.LocalAlias
	}
	if strings.TrimSpace(alias) == "" {
		return nil, "alias must not be empty"
	}
	if strict && !isValidBucketAlias(alias) {
		return nil, invalidAliasMessage
	}
	if hasGlobal {
		return map[string]any{"bucketId": bucketID, "globalAlias": alias}, ""
	}
	if req.AccessKeyID == nil || strings.TrimSpace(*req.AccessKeyID) == "" {
		return nil, "accessKeyId is required with localAlias"
	}
	return map[string]any{"bucketId": bucketID, "localAlias": alias, "accessKeyId": *req.AccessKeyID}, ""
}

// handleBucketAlias serves POST /api/buckets/{id}/aliases (add → Garage
// AddBucketAlias) and DELETE /api/buckets/{id}/aliases (→ RemoveBucketAlias),
// injecting the bucket ID from the URL. Garage answers with the updated
// GetBucketInfo response, which is forwarded as-is; the list caches are
// cleared on success because the bucket and key lists show aliases.
func handleBucketAlias(garageAdmin *GarageAdminClient, add bool) http.HandlerFunc {
	garagePath := "/v2/RemoveBucketAlias"
	if add {
		garagePath = "/v2/AddBucketAlias"
	}
	return func(w http.ResponseWriter, r *http.Request) {
		bucketID := chi.URLParam(r, "id")

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
		body, msg := req.garageBody(bucketID, add)
		if msg != "" {
			writeJSONError(w, http.StatusBadRequest, msg)
			return
		}
		b, err := json.Marshal(body)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		proxyGarageMutation(w, r, garageAdmin, garagePath, bytes.NewReader(b))
	}
}
