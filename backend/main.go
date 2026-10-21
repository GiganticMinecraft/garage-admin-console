package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// newRouter builds the chi router with all routes wired up.
func newRouter(garageAdmin *GarageAdminClient, s3Client *S3Client) chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	// accessLog sits outside Recoverer so a panicking handler is still
	// logged (and audited) with the 500 that Recoverer writes.
	r.Use(accessLog)
	r.Use(middleware.Recoverer)

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
			r.Post("/connect", handleConnectNodes(garageAdmin))
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
			r.Post("/{id}/aliases", handleAddBucketAlias(garageAdmin))
			r.Delete("/{id}/aliases/{alias}", handleRemoveBucketAlias(garageAdmin))
			r.Post("/{id}/console-access", handleGrantConsoleAccess(garageAdmin, consoleKeyIDFromEnv()))
			r.Get("/{id}/objects/inspect", handleInspectObject(garageAdmin))
		})

		r.Route("/api/keys", func(r chi.Router) {
			r.Get("/", handleListKeys(garageAdmin))
			r.Post("/", handleCreateKey(garageAdmin))
			r.Post("/import", handleImportKey(garageAdmin))
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
			r.Get("/console-scope", handleConsoleScope())
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

		r.Get("/api/s3/connection", handleS3Connection())
	})

	return r
}

// Termination budget. The production Deployment gives the pod
// terminationGracePeriodSeconds 30 and spends the first 5s in a preStop
// sleep, so SIGTERM arrives with ~25s left before SIGKILL. drainTimeout lets
// in-flight requests (uploads, ZIP downloads) finish within that window, and
// telemetryShutdownTimeout bounds the final OTLP flush so the whole sequence
// still ends before the kubelet kills the process.
const (
	drainTimeout             = 20 * time.Second
	telemetryShutdownTimeout = 4 * time.Second
)

func main() {
	slog.SetDefault(slog.New(newTraceHandler(slog.NewJSONHandler(os.Stderr, nil))))

	// The os.Exit(1) calls during startup (here and in initAuth,
	// newGarageAdminClient, newS3Client) skip deferred calls; that is fine
	// because nothing has been served or recorded yet.
	shutdownTelemetry, err := initTelemetry(context.Background())
	if err != nil {
		slog.Error("failed to init telemetry", "error", err)
		os.Exit(1)
	}

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
	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	// Restore default signal handling once the first signal arrives, so a
	// second Ctrl-C/SIGTERM terminates immediately instead of being swallowed.
	context.AfterFunc(ctx, stop)

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		slog.Error("failed to listen", "addr", addr, "error", err)
		os.Exit(1)
	}
	slog.Info("starting server", "addr", addr)
	serveErr := serve(ctx, srv, ln, drainTimeout)

	// Flush spans/metrics recorded up to (and during) the drain. This runs on
	// the error path too, since os.Exit below would skip any defer.
	tctx, cancel := context.WithTimeout(context.Background(), telemetryShutdownTimeout)
	shutdownTelemetry(tctx)
	cancel()

	if serveErr != nil {
		slog.Error("server error", "error", serveErr)
		os.Exit(1)
	}
	slog.Info("shutdown complete")
}

// serve runs srv on ln until it fails or ctx is cancelled. On cancellation it stops
// accepting new connections and waits up to drain for in-flight requests; any
// still running after that are cut off with srv.Close. It returns nil after a
// signal-triggered shutdown and the listener's error otherwise.
func serve(ctx context.Context, srv *http.Server, ln net.Listener, drain time.Duration) error {
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	slog.Info("shutdown signal received", "drain_timeout", drain.String())
	sctx, cancel := context.WithTimeout(context.Background(), drain)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil {
		slog.Warn("drain timed out, closing remaining connections", "error", err)
		if err := srv.Close(); err != nil {
			slog.Warn("failed to close server", "error", err)
		}
	}
	if err := <-errCh; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
