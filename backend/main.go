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

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))

	shutdown, err := initTracer(context.Background())
	if err != nil {
		slog.Error("failed to init tracer", "error", err)
		os.Exit(1)
	}
	defer shutdown()

	initAuth()
	garageAdmin := newGarageAdminClient()

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
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
			r.Post("/layout", handleApplyLayout(garageAdmin))
		})

		r.Route("/api/buckets", func(r chi.Router) {
			r.Get("/", handleListBuckets(garageAdmin))
			r.Post("/", handleCreateBucket(garageAdmin))
			r.Get("/{id}", handleGetBucket(garageAdmin))
			r.Put("/{id}", handleUpdateBucket(garageAdmin))
			r.Delete("/{id}", handleDeleteBucket(garageAdmin))
			r.Post("/{id}/keys", handleGrantBucketKey(garageAdmin))
			r.Delete("/{id}/keys/{kid}", handleRevokeBucketKey(garageAdmin))
		})
	})

	addr := ":8080"
	handler := otelhttp.NewHandler(r, "garage-admin-console")
	slog.Info("starting server", "addr", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
}
