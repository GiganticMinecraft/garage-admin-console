package main

import (
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
// Garage only offers AllowBucketKey (sets the given flags) and DenyBucketKey
// (clears the given flags), so this reads the current permissions with
// GetBucketInfo and sends AllowBucketKey for the flags being turned on and
// DenyBucketKey for the flags being turned off, skipping a call that would be
// a no-op. At least one flag must be true; revoking everything stays on
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

		infoPath := "/v2/GetBucketInfo?id=" + url.QueryEscape(bucketID)
		var info garageBucketKeys
		if err := garageGetJSON(r.Context(), garageAdmin, infoPath, &info); err != nil {
			writeGarageCallError(w, r, infoPath, err)
			return
		}
		if info.ID != "" {
			bucketID = info.ID
		}
		current := info.permsOf(keyID)

		allow := bucketKeyPerm{
			Read:  desired.Read && !current.Read,
			Write: desired.Write && !current.Write,
			Owner: desired.Owner && !current.Owner,
		}
		deny := bucketKeyPerm{
			Read:  !desired.Read && current.Read,
			Write: !desired.Write && current.Write,
			Owner: !desired.Owner && current.Owner,
		}

		result := current
		changed := false
		// Allow first: a failure midway then leaves the key with more of the
		// requested access instead of locking it out.
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
				writeJSONError(w, http.StatusInternalServerError, err.Error())
				return
			}
			var after garageBucketKeys
			if err := garageRequestJSON(r.Context(), garageAdmin, http.MethodPost, step.path, body, &after); err != nil {
				if changed {
					invalidateListCaches()
				}
				writeGarageCallError(w, r, step.path, err)
				return
			}
			changed = true
			result = after.permsOf(keyID)
		}
		if changed {
			invalidateListCaches()
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(bucketKeyPermsResponse{
			BucketID:    bucketID,
			AccessKeyID: keyID,
			Permissions: result,
			Changed:     changed,
		})
	}
}
