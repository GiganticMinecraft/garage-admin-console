package main

import (
	"encoding/json"
	"net/http"
	"os"
)

// s3ConnectionInfo is the body of GET /api/s3/connection: what an S3 client
// needs besides the key pair.
type s3ConnectionInfo struct {
	Region   string `json:"region"`
	Endpoint string `json:"endpoint"`
	// PublicEndpoint is false when GARAGE_S3_PUBLIC_ENDPOINT is unset and the
	// endpoint is the backend's own (possibly cluster-internal) S3 URL.
	PublicEndpoint bool `json:"publicEndpoint"`
	// AccessKeyID is the console's own S3 key (GARAGE_S3_ACCESS_KEY), used by
	// the object browser. Only the ID is exposed, never the secret.
	AccessKeyID string `json:"accessKeyId"`
}

// s3ConnectionInfoFromEnv reads the connection parameters shown to operators.
// GARAGE_S3_PUBLIC_ENDPOINT (optional) is the URL clients outside the cluster
// should use; it falls back to the backend's own endpoint and region
// (s3EndpointFromEnv / s3RegionFromEnv, shared with newS3Client).
func s3ConnectionInfoFromEnv() s3ConnectionInfo {
	info := s3ConnectionInfo{
		Region:      s3RegionFromEnv(),
		Endpoint:    os.Getenv("GARAGE_S3_PUBLIC_ENDPOINT"),
		AccessKeyID: consoleKeyIDFromEnv(),
	}
	if info.Endpoint != "" {
		info.PublicEndpoint = true
	} else {
		info.Endpoint = s3EndpointFromEnv()
	}
	return info
}

// handleS3Connection serves GET /api/s3/connection. The environment does not
// change at runtime, so the values are read once when the router is built.
func handleS3Connection() http.HandlerFunc {
	info := s3ConnectionInfoFromEnv()
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(info)
	}
}
