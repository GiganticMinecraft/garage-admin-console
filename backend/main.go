package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// newRouter builds the chi router with all routes wired up.
func newRouter(garageAdmin *GarageAdminClient, s3Client *S3Client) chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(accessLog)

	r.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})

	// OAuth flow routes (no auth required).
	r.Get("/api/auth/login", handleLogin)
	r.Get("/api/auth/callback", handleCallback)

	// Protected routes (auth + CSRF required).
	r.Group(func(r chi.Router) {
		r.Use(authMiddleware)
		r.Use(csrfMiddleware)

		r.Get("/api/auth/me", handleMe)
		r.Post("/api/auth/logout", handleLogout)

		r.Route("/api/cluster", func(r chi.Router) {
			r.Get("/health", handleClusterHealth(garageAdmin))
			r.Get("/status", handleClusterStatus(garageAdmin))
			r.Get("/layout", handleClusterLayout(garageAdmin))
			r.Post("/layout/stage", handleStageLayout(garageAdmin))
			r.Post("/layout/preview", handlePreviewLayout(garageAdmin))
			r.Post("/layout/apply", handleApplyLayout(garageAdmin))
			r.Post("/layout/revert", handleRevertLayout(garageAdmin))
			r.Get("/layout/history", handleLayoutHistory(garageAdmin))
			r.Post("/layout/skip-dead-nodes", handleSkipDeadNodes(garageAdmin))
			r.Get("/statistics", handleClusterStatistics(garageAdmin))
			r.Get("/storage-health", handleStorageHealth(garageAdmin))
		})

		r.Route("/api/buckets", func(r chi.Router) {
			r.Get("/", handleListBuckets(garageAdmin))
			r.Post("/", handleCreateBucket(garageAdmin))
			r.Get("/{id}", handleGetBucket(garageAdmin))
			r.Put("/{id}", handleUpdateBucket(garageAdmin))
			r.Delete("/{id}", handleDeleteBucket(garageAdmin))
			r.Post("/{id}/keys", handleGrantBucketKey(garageAdmin))
			r.Delete("/{id}/keys/{kid}", handleRevokeBucketKey(garageAdmin))
			r.Post("/{id}/cleanup-uploads", handleCleanupIncompleteUploads(garageAdmin))
			r.Put("/{id}/keys/{kid}", handleSetBucketKeyPermissions(garageAdmin))
			r.Post("/{id}/aliases", handleBucketAlias(garageAdmin, true))
			r.Delete("/{id}/aliases", handleBucketAlias(garageAdmin, false))
		})

		r.Route("/api/keys", func(r chi.Router) {
			r.Get("/", handleListKeys(garageAdmin))
			r.Post("/", handleCreateKey(garageAdmin))
			r.Get("/{id}", handleGetKey(garageAdmin))
			r.Put("/{id}", handleUpdateKey(garageAdmin))
			r.Delete("/{id}", handleDeleteKey(garageAdmin))
		})

		r.Route("/api/objects", func(r chi.Router) {
			r.Get("/{bucket}/list", handleListObjects(s3Client))
			r.Get("/{bucket}/download", handleDownloadObject(s3Client))
			r.Post("/{bucket}/batch-download", handleBatchDownloadObjects(s3Client))
			r.Get("/{bucket}/batch-download", handleBatchDownloadObjectsGet(s3Client))
			r.Post("/{bucket}/upload", handleUploadObject(s3Client))
			r.Delete("/{bucket}", handleDeleteObject(s3Client))
			r.Delete("/{bucket}/batch", handleBatchDeleteObjects(s3Client))
			r.Get("/{bucket}/prefix-summary", handlePrefixSummary(s3Client))
			r.Delete("/{bucket}/prefix", handleDeletePrefix(s3Client))
		})

		r.Get("/api/workers", handleListWorkers(garageAdmin))

		r.Route("/api/admin-tokens", func(r chi.Router) {
			r.Get("/", handleListAdminTokens(garageAdmin))
			r.Post("/", handleCreateAdminToken(garageAdmin))
			r.Get("/current", handleGetCurrentAdminToken(garageAdmin))
			r.Get("/{id}", handleGetAdminToken(garageAdmin))
			r.Put("/{id}", handleUpdateAdminToken(garageAdmin))
			r.Delete("/{id}", handleDeleteAdminToken(garageAdmin))
		})

		r.Route("/api/blocks", func(r chi.Router) {
			r.Get("/errors", handleListBlockErrors(garageAdmin))
			r.Post("/info", handleGetBlockInfo(garageAdmin))
			r.Post("/purge", handlePurgeBlocks(garageAdmin))
			r.Post("/resync", handleRetryBlockResync(garageAdmin))
		})

		r.Post("/api/repair", handleLaunchRepair(garageAdmin))

		r.Route("/api/nodes/{id}", func(r chi.Router) {
			r.Get("/", handleGetNode(garageAdmin))
			r.Get("/stats", handleGetNodeStats(garageAdmin))
			r.Get("/worker-variables", handleGetNodeWorkerVariables(garageAdmin))
			r.Post("/worker-variables", handleSetNodeWorkerVariable(garageAdmin))
			r.Post("/repair", handleLaunchNodeRepair(garageAdmin))
			r.Post("/snapshot", handleCreateNodeSnapshot(garageAdmin))
			r.Get("/workers", handleListNodeWorkers(garageAdmin))
		})

		r.Get("/api/metrics", handleMaintenanceMetrics(garageAdmin))

		r.Get("/api/s3/connection", handleS3Connection())
	})

	return r
}

func main() {
	slog.SetDefault(slog.New(newTraceHandler(slog.NewJSONHandler(os.Stderr, nil))))

	shutdown, err := initTelemetry(context.Background())
	if err != nil {
		slog.Error("failed to init telemetry", "error", err)
		os.Exit(1)
	}
	defer shutdown()

	initAuth()
	garageAdmin := newGarageAdminClient()
	s3Client := newS3Client()

	r := newRouter(garageAdmin, s3Client)

	addr := ":8080"
	handler := otelhttp.NewHandler(r, "garage-admin-console",
		otelhttp.WithFilter(func(r *http.Request) bool {
			return r.URL.Path != "/api/health"
		}),
	)
	slog.Info("starting server", "addr", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
}
