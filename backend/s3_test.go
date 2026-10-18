package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// TestS3ClientStreamsBodyLongerThanHeaderTimeout guards against the regression
// where http.Client.Timeout cut off object transfers that outlived the timeout.
// The fake S3 server answers headers immediately but trickles the body over a
// period longer than the header timeout; the full body must still arrive.
func TestS3ClientStreamsBodyLongerThanHeaderTimeout(t *testing.T) {
	const chunks = 6
	const chunkDelay = 100 * time.Millisecond
	headerTimeout := 200 * time.Millisecond // body takes ~600ms > 200ms

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", "6")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for i := 0; i < chunks; i++ {
			time.Sleep(chunkDelay)
			io.WriteString(w, "x")
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer srv.Close()

	client := newS3SDKClient(srv.URL, "garage", "ak", "sk", headerTimeout)
	out, err := client.GetObject(context.Background(), &s3.GetObjectInput{
		Bucket: aws.String("b"),
		Key:    aws.String("k"),
	})
	if err != nil {
		t.Fatalf("GetObject: %v", err)
	}
	defer out.Body.Close()
	body, err := io.ReadAll(out.Body)
	if err != nil {
		t.Fatalf("reading body was cut off: %v", err)
	}
	if got := string(body); got != strings.Repeat("x", chunks) {
		t.Fatalf("body = %q, want %d bytes", got, chunks)
	}
}

// TestS3ClientHeaderTimeoutStillApplies makes sure a server that never sends
// headers is still given up on, so a hung Garage does not pin goroutines.
func TestS3ClientHeaderTimeoutStillApplies(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer srv.Close()
	defer close(release)

	// Disable the SDK's retries so the measured duration reflects a single
	// attempt; with the default retryer the three attempts plus backoff make
	// the timing meaningless on slow CI runners.
	noRetry := func(o *s3.Options) { o.Retryer = aws.NopRetryer{} }
	client := newS3SDKClient(srv.URL, "garage", "ak", "sk", 100*time.Millisecond, noRetry)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	_, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String("b"), Key: aws.String("k")})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected an error from a server that never responds")
	}
	if ctx.Err() != nil || elapsed > 5*time.Second {
		t.Fatalf("request did not time out via ResponseHeaderTimeout (took %s, err=%v)", elapsed, err)
	}
	if !strings.Contains(err.Error(), "timeout awaiting response headers") {
		t.Fatalf("expected a response header timeout, got: %v", err)
	}
}
