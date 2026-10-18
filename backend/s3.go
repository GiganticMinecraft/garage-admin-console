package main

import (
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// S3Client wraps an *s3.Client for object operations against Garage's S3 API.
type S3Client struct {
	client *s3.Client
}

// newS3Client creates a new S3Client configured from environment variables.
// Required: GARAGE_S3_ACCESS_KEY, GARAGE_S3_SECRET_KEY.
// Optional: GARAGE_S3_ENDPOINT (default: http://garage.garage.svc.cluster.local:3900),
//
//	GARAGE_S3_REGION (default: seichi-cloud).
func newS3Client() *S3Client {
	endpoint := os.Getenv("GARAGE_S3_ENDPOINT")
	if endpoint == "" {
		endpoint = "http://garage.garage.svc.cluster.local:3900"
	}

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

	region := os.Getenv("GARAGE_S3_REGION")
	if region == "" {
		region = "seichi-cloud"
	}

	return &S3Client{client: newS3SDKClient(endpoint, region, accessKey, secretKey, 30*time.Second)}
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
