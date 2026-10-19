package main

import (
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// S3Client wraps an *s3.Client for object operations against Garage's S3 API.
type S3Client struct {
	client *s3.Client
	// maxUploadBytes caps the request body of a single upload. Zero means
	// defaultMaxUploadBytes (see uploadLimit).
	maxUploadBytes int64
}

// defaultMaxUploadBytes is the per-request upload cap when
// GARAGE_MAX_UPLOAD_BYTES is unset: 10 GiB.
const defaultMaxUploadBytes int64 = 10 << 30

// uploadLimit returns the effective per-request upload cap.
func (c *S3Client) uploadLimit() int64 {
	if c.maxUploadBytes > 0 {
		return c.maxUploadBytes
	}
	return defaultMaxUploadBytes
}

// parseMaxUploadBytes reads GARAGE_MAX_UPLOAD_BYTES (a positive integer byte
// count). Invalid values are logged and replaced by the default.
func parseMaxUploadBytes(v string) int64 {
	if v == "" {
		return defaultMaxUploadBytes
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		slog.Warn("invalid GARAGE_MAX_UPLOAD_BYTES, using default", "value", v, "default", defaultMaxUploadBytes)
		return defaultMaxUploadBytes
	}
	return n
}

// newS3Client creates a new S3Client configured from environment variables.
// Required: GARAGE_S3_ACCESS_KEY, GARAGE_S3_SECRET_KEY.
// Optional: GARAGE_S3_ENDPOINT (default: http://garage.garage.svc.cluster.local:3900),
//
//	GARAGE_S3_REGION (default: seichi-cloud),
//	GARAGE_MAX_UPLOAD_BYTES (default: 10 GiB).
func newS3Client() *S3Client {
	endpoint := s3EndpointFromEnv()

	accessKey := os.Getenv("GARAGE_S3_ACCESS_KEY")
	if accessKey == "" {
		slog.Error("GARAGE_S3_ACCESS_KEY is required")
		os.Exit(1)
	}

	secretKey := os.Getenv("GARAGE_S3_SECRET_KEY")
	if secretKey == "" {
		slog.Error("GARAGE_S3_SECRET_KEY is required")
		os.Exit(1)
	}

	region := s3RegionFromEnv()

	return &S3Client{
		client:         newS3SDKClient(endpoint, region, accessKey, secretKey, 30*time.Second),
		maxUploadBytes: parseMaxUploadBytes(os.Getenv("GARAGE_MAX_UPLOAD_BYTES")),
	}
}

// s3EndpointFromEnv is the S3 API URL the backend talks to:
// GARAGE_S3_ENDPOINT, default http://garage.garage.svc.cluster.local:3900.
func s3EndpointFromEnv() string {
	if v := os.Getenv("GARAGE_S3_ENDPOINT"); v != "" {
		return v
	}
	return "http://garage.garage.svc.cluster.local:3900"
}

// s3RegionFromEnv is the S3 region: GARAGE_S3_REGION, default seichi-cloud.
func s3RegionFromEnv() string {
	if v := os.Getenv("GARAGE_S3_REGION"); v != "" {
		return v
	}
	return "seichi-cloud"
}

// newS3SDKClient builds the underlying SDK client.
//
// It deliberately does not set http.Client.Timeout: that bounds the whole
// exchange including the body transfer, so any upload, download or ZIP stream
// taking longer than the timeout is cut off mid-transfer (multi-GB world
// backups routinely exceed 30s). Only the wait for response headers is
// bounded; the body transfer is governed by the request context, which is
// cancelled when the browser disconnects.
func newS3SDKClient(endpoint, region, accessKey, secretKey string, headerTimeout time.Duration, optFns ...func(*s3.Options)) *s3.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = headerTimeout

	return s3.New(s3.Options{
		BaseEndpoint: aws.String(endpoint),
		Region:       region,
		Credentials:  credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
		UsePathStyle: true,
		HTTPClient: &http.Client{
			Transport: otelhttp.NewTransport(transport),
		},
	}, optFns...)
}
