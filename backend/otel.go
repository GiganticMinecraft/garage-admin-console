package main

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/contrib/processors/baggagecopy"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// serviceName is the default OTel service.name and Pyroscope application
// name, kept the same so traces, metrics and profiles of this service can be
// correlated in Grafana.
const serviceName = "garage-admin-console"

// initTelemetry sets up the global tracer and meter providers. The returned
// function flushes buffered telemetry and shuts both providers and the
// Pyroscope profiler (see startProfiling) down; ctx bounds how long that may
// take.
func initTelemetry(ctx context.Context) (func(context.Context), error) {
	// sdktrace/metric.WithResource already merge resource.Environment()
	// underneath res, but with res winning on conflicts. Listing WithFromEnv
	// last lets OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES override the
	// defaults set here, the precedence the OTel spec expects.
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(serviceName),
			semconv.ServiceVersion(version),
		),
		resource.WithTelemetrySDK(),
		resource.WithHost(),
		resource.WithFromEnv(),
	)
	if errors.Is(err, resource.ErrPartialResource) {
		// A malformed OTEL_RESOURCE_ATTRIBUTES entry or a failed hostname
		// lookup only drops those attributes; keep running with the rest.
		slog.Warn("some OTel resource attributes could not be detected", "error", err)
	} else if err != nil {
		return nil, err
	}

	// Traces
	traceExporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter),
		sdktrace.WithResource(res),
		sdktrace.WithSpanProcessor(baggagecopy.NewSpanProcessor(baggagecopy.AllowAllMembers)),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	// Metrics
	metricExporter, err := otlpmetrichttp.New(ctx)
	if err != nil {
		return nil, err
	}

	mp := metric.NewMeterProvider(
		metric.WithResource(res),
		metric.WithReader(metric.NewPeriodicReader(metricExporter)),
	)
	otel.SetMeterProvider(mp)

	if err := runtime.Start(); err != nil {
		return nil, err
	}

	stopProfiling := startProfiling()

	// Shut the providers and the profiler down in parallel so a slow exporter
	// cannot use up the deadline before the others get their final export.
	return func(ctx context.Context) {
		var wg sync.WaitGroup
		wg.Go(func() {
			if err := tp.Shutdown(ctx); err != nil {
				slog.Error("error shutting down tracer", "error", err)
			}
		})
		wg.Go(func() {
			if err := mp.Shutdown(ctx); err != nil {
				slog.Error("error shutting down meter", "error", err)
			}
		})
		wg.Go(func() { stopProfiling(ctx) })
		wg.Wait()
	}, nil
}
