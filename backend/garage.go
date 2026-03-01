package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// GarageAdminClient is a thin HTTP client wrapper for the Garage Admin API.
type GarageAdminClient struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

// newGarageAdminClient creates a new GarageAdminClient configured from
// environment variables. GARAGE_ADMIN_ENDPOINT sets the base URL (default:
// http://garage.garage.svc.cluster.local:3903) and GARAGE_ADMIN_TOKEN sets the
// Bearer token.
func newGarageAdminClient() *GarageAdminClient {
	baseURL := os.Getenv("GARAGE_ADMIN_ENDPOINT")
	if baseURL == "" {
		baseURL = "http://garage.garage.svc.cluster.local:3903"
	}
	token := os.Getenv("GARAGE_ADMIN_TOKEN")
	if token == "" {
		slog.Error("GARAGE_ADMIN_TOKEN is required")
		os.Exit(1)
	}
	return &GarageAdminClient{
		baseURL: baseURL,
		token:   token,
		httpClient: &http.Client{
			Transport: otelhttp.NewTransport(http.DefaultTransport),
			Timeout:   10 * time.Second,
		},
	}
}

// doRequest builds and executes an HTTP request against the Garage Admin API.
// The caller is responsible for closing the response body.
func (c *GarageAdminClient) doRequest(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, fmt.Errorf("creating garage request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.httpClient.Do(req)
}
