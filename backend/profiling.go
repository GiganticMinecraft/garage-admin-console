package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/grafana/pyroscope-go"
)

// pyroscopeUploadTimeout bounds each profile upload. The library default is
// 30s, which would let the final upload in Stop outlive the termination
// budget described in main.go.
const pyroscopeUploadTimeout = 3 * time.Second

// startProfiling starts pushing continuous profiles to Pyroscope when
// PYROSCOPE_SERVER_ADDRESS is set and returns a function that stops the
// profiler, uploading what it has collected, within ctx's deadline. With the
// variable unset (or if the profiler cannot start) it returns a no-op, since
// profiling is not required for the console to work.
func startProfiling() func(context.Context) {
	noop := func(context.Context) {}

	addr := os.Getenv("PYROSCOPE_SERVER_ADDRESS")
	if addr == "" {
		return noop
	}
	name := os.Getenv("PYROSCOPE_APPLICATION_NAME")
	if name == "" {
		name = "garage-admin-api"
	}

	profiler, err := pyroscope.Start(pyroscope.Config{
		ApplicationName: name,
		ServerAddress:   addr,
		Logger:          slogPyroscopeLogger{},
		HTTPClient:      &http.Client{Timeout: pyroscopeUploadTimeout},
		Tags:            map[string]string{"service_version": version},
		ProfileTypes: []pyroscope.ProfileType{
			pyroscope.ProfileCPU,
			pyroscope.ProfileAllocObjects,
			pyroscope.ProfileAllocSpace,
			pyroscope.ProfileInuseObjects,
			pyroscope.ProfileInuseSpace,
			pyroscope.ProfileGoroutines,
		},
	})
	if err != nil {
		slog.Warn("failed to start pyroscope profiler, continuing without profiling", "error", err)
		return noop
	}
	slog.Info("pyroscope profiler started", "server_address", addr, "application_name", name)

	return func(ctx context.Context) {
		// Stop has no context; run it in the background so a slow Pyroscope
		// cannot hold up the exit past ctx's deadline.
		done := make(chan struct{})
		go func() {
			defer close(done)
			if err := profiler.Stop(); err != nil {
				slog.Error("error stopping pyroscope profiler", "error", err)
			}
		}()
		select {
		case <-done:
		case <-ctx.Done():
			slog.Warn("pyroscope profiler did not stop in time", "error", ctx.Err())
		}
	}
}

// slogPyroscopeLogger forwards pyroscope-go's errors (failed uploads, dropped
// jobs) to slog and discards its info/debug chatter.
type slogPyroscopeLogger struct{}

func (slogPyroscopeLogger) Infof(string, ...any)  {}
func (slogPyroscopeLogger) Debugf(string, ...any) {}
func (slogPyroscopeLogger) Errorf(format string, args ...any) {
	slog.Warn("pyroscope: " + fmt.Sprintf(format, args...))
}
