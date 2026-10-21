package main

import (
	"context"
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

// initTelemetry sets up the global tracer and meter providers. The returned
// function flushes buffered telemetry and shuts both providers down; ctx
// bounds how long that may take.
func initTelemetry(ctx context.Context) (func(context.Context), error) {
	// resource.New only runs the detectors it is given, so the env detector
	// must be listed explicitly for OTEL_RESOURCE_ATTRIBUTES and
	// OTEL_SERVICE_NAME to take effect. Later options win on conflicting
	// keys, so the env values override the defaults above them.
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName("garage-admin-console"),
			semconv.ServiceVersion(version),
		),
		resource.WithTelemetrySDK(),
		resource.WithHost(),
		resource.WithFromEnv(),
	)
	if err != nil {
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
