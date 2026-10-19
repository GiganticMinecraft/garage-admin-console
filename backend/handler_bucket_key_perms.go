package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
)

// bucketKeyPerm mirrors Garage's ApiBucketKeyPerm.
type bucketKeyPerm struct {
	Read  bool `json:"read"`
	Write bool `json:"write"`
	Owner bool `json:"owner"`
}

func (p bucketKeyPerm) any() bool { return p.Read || p.Write || p.Owner }

// bucketKeyPermsResponse is the body of PUT /api/buckets/{id}/keys/{kid}.
type bucketKeyPermsResponse struct {
	BucketID    string        `json:"bucketId"`
	AccessKeyID string        `json:"accessKeyId"`
	Permissions bucketKeyPerm `json:"permissions"`
	// Changed is false when the requested permissions were already in place
	// and no Garage mutation was sent.
	Changed bool `json:"changed"`
}

// garageBucketKeys is the subset of Garage's GetBucketInfoResponse (also the
// AllowBucketKey / DenyBucketKey response) needed to read one key's permissions.
type garageBucketKeys struct {
	ID   string `json:"id"`
	Keys []struct {
		AccessKeyID string        `json:"accessKeyId"`
		Permissions bucketKeyPerm `json:"permissions"`
	} `json:"keys"`
}

func (b garageBucketKeys) permsOf(keyID string) bucketKeyPerm {
	for _, k := range b.Keys {
		if k.AccessKeyID == keyID {
			return k.Permissions
		}
	}
	return bucketKeyPerm{}
}

// writeGarageCallError reports a garageRequestJSON failure: Garage's own
// error answers (*garageStatusError) are forwarded as-is so the UI can show
// Garage's message; transport and decoding failures become a 502.
func writeGarageCallError(w http.ResponseWriter, r *http.Request, path string, err error) {
	var ge *garageStatusError
	if errors.As(err, &ge) {
		ct := ge.contentType
		if ct == "" {
			ct = "application/json"
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(ge.status)
		w.Write(ge.body)
		return
	}
	slog.ErrorContext(r.Context(), "garage request failed", "path", path, "error", err)
	writeJSONError(w, http.StatusBadGateway, "Bad Gateway")
}

// handleSetBucketKeyPermissions handles PUT /api/buckets/{id}/keys/{kid} with
// body {"read":bool,"write":bool,"owner":bool}: the desired permission set of
// one key on one bucket.
//
// See setBucketKeyPermissions for how this maps onto Garage. At least one
// flag must be true; revoking everything stays on
// DELETE /api/buckets/{id}/keys/{kid}.
func handleSetBucketKeyPermissions(garageAdmin *GarageAdminClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bucketID := chi.URLParam(r, "id")
		keyID := chi.URLParam(r, "kid")

		var desired bucketKeyPerm
		dec := json.NewDecoder(io.LimitReader(r.Body, 1<<16))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&desired); err != nil {
			writeJSONError(w, http.StatusBadRequest, `invalid request body: expected {"read":bool,"write":bool,"owner":bool}`)
			return
		}
		if !desired.any() {
			writeJSONError(w, http.StatusBadRequest, "at least one of read, write or owner is required (use DELETE to revoke all permissions)")
			return
		}

		resp, path, err := setBucketKeyPermissions(r.Context(), garageAdmin, bucketID, keyID,
			func(bucketKeyPerm) bucketKeyPerm { return desired })
		if err != nil {
			writeGarageCallError(w, r, path, err)
			return
		}
		writeJSON(w, resp)
	}
}

// writeJSON writes v as a 200 JSON response.
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// setBucketKeyPermissions sets one key's permissions on one bucket to
// desired(current), where current is read with GetBucketInfo first.
//
// Garage only offers AllowBucketKey (sets the given flags) and DenyBucketKey
// (clears the given flags), so this sends AllowBucketKey for the flags being
// turned on and DenyBucketKey for the flags being turned off, skipping a call
// that would be a no-op. Allow goes first: a failure midway then leaves the
// key with more of the requested access instead of locking it out.
//
// On failure it also returns the Garage path that failed, for
// writeGarageCallError. The list caches are invalidated whenever Garage
// accepted a change, including when a later step then failed.
func setBucketKeyPermissions(ctx context.Context, garageAdmin *GarageAdminClient, bucketID, keyID string, desired func(current bucketKeyPerm) bucketKeyPerm) (bucketKeyPermsResponse, string, error) {
	infoPath := "/v2/GetBucketInfo?id=" + url.QueryEscape(bucketID)
	var info garageBucketKeys
	if err := garageGetJSON(ctx, garageAdmin, infoPath, &info); err != nil {
		return bucketKeyPermsResponse{}, infoPath, err
	}
	if info.ID != "" {
		bucketID = info.ID
	}
	current := info.permsOf(keyID)
	want := desired(current)

	allow := bucketKeyPerm{
		Read:  want.Read && !current.Read,
		Write: want.Write && !current.Write,
		Owner: want.Owner && !current.Owner,
	}
	deny := bucketKeyPerm{
		Read:  !want.Read && current.Read,
		Write: !want.Write && current.Write,
		Owner: !want.Owner && current.Owner,
	}

	result := current
	changed := false
	for _, step := range []struct {
		path  string
		perms bucketKeyPerm
	}{
		{"/v2/AllowBucketKey", allow},
		{"/v2/DenyBucketKey", deny},
	} {
		if !step.perms.any() {
			continue
		}
		body, err := json.Marshal(map[string]any{
			"bucketId":    bucketID,
			"accessKeyId": keyID,
			"permissions": step.perms,
		})
		if err != nil {
			return bucketKeyPermsResponse{}, step.path, err
		}
		var after garageBucketKeys
		if err := garageRequestJSON(ctx, garageAdmin, http.MethodPost, step.path, body, &after); err != nil {
			if changed {
				invalidateListCaches()
			}
			return bucketKeyPermsResponse{}, step.path, err
		}
		changed = true
		result = after.permsOf(keyID)
	}
	if changed {
		invalidateListCaches()
	}
	return bucketKeyPermsResponse{
		BucketID:    bucketID,
		AccessKeyID: keyID,
		Permissions: result,
		Changed:     changed,
	}, "", nil
}
