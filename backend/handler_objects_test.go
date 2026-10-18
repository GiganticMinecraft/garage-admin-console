package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/go-chi/chi/v5"
)

func TestAttachmentDisposition(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"ascii", "world.tar.zst", `attachment; filename="world.tar.zst"; filename*=UTF-8''world.tar.zst`},
		{"japanese", "ワールド.zip", `attachment; filename="____.zip"; filename*=UTF-8''%E3%83%AF%E3%83%BC%E3%83%AB%E3%83%89.zip`},
		{"quote and backslash", `a"b\c.txt`, `attachment; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`},
		{"control chars dropped", "a\r\nb.txt", `attachment; filename="ab.txt"; filename*=UTF-8''a%0D%0Ab.txt`},
		{"empty", "", `attachment; filename="download"; filename*=UTF-8''download`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := attachmentDisposition(c.in); got != c.want {
				t.Errorf("attachmentDisposition(%q)\n got: %s\nwant: %s", c.in, got, c.want)
			}
		})
	}
}

func TestZipFilename(t *testing.T) {
	if got := zipFilename("611e4978", ""); got != "611e4978-files.zip" {
		t.Errorf("fallback to bucket id: got %q", got)
	}
	if got := zipFilename("611e4978", "mc-worlds"); got != "mc-worlds-files.zip" {
		t.Errorf("alias preferred: got %q", got)
	}
}

// TestDownloadObjectIntegration runs against a real Garage when
// GARAGE_TEST_S3_ENDPOINT / GARAGE_TEST_S3_ACCESS_KEY / GARAGE_TEST_S3_SECRET_KEY /
// GARAGE_TEST_S3_BUCKET are set (see scratchpad/garage in the dev notes).
func TestDownloadObjectIntegration(t *testing.T) {
	endpoint := os.Getenv("GARAGE_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("GARAGE_TEST_S3_ENDPOINT not set")
	}
	bucket := os.Getenv("GARAGE_TEST_S3_BUCKET")
	client := newS3SDKClient(endpoint, "garage", os.Getenv("GARAGE_TEST_S3_ACCESS_KEY"), os.Getenv("GARAGE_TEST_S3_SECRET_KEY"), 5*time.Second)
	s3c := &S3Client{client: client}

	const key = "dir/ワールド \"quoted\".txt"
	if _, err := client.PutObject(context.Background(), &s3.PutObjectInput{
		Bucket: aws.String(bucket), Key: aws.String(key), Body: strings.NewReader("hello"),
		ContentType: aws.String("text/plain"),
	}); err != nil {
		t.Fatalf("PutObject: %v", err)
	}

	r := chi.NewRouter()
	r.Get("/api/objects/{bucket}/download", handleDownloadObject(s3c))
	req := httptest.NewRequest(http.MethodGet, "/api/objects/"+bucket+"/download?key="+url.QueryEscape(key), nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "hello" {
		t.Fatalf("body = %q", got)
	}
	want := `attachment; filename="____ _quoted_.txt"; filename*=UTF-8''%E3%83%AF%E3%83%BC%E3%83%AB%E3%83%89%20%22quoted%22.txt`
	if got := rec.Header().Get("Content-Disposition"); got != want {
		t.Errorf("Content-Disposition = %s\nwant %s", got, want)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/plain" {
		t.Errorf("Content-Type = %q", got)
	}
}
