import { getWebInstrumentations, initializeFaro } from '@grafana/faro-web-sdk'
import { TracingInstrumentation } from '@grafana/faro-web-tracing'

export function setupFaro() {
  if (import.meta.env.PROD) {
    initializeFaro({
      url: '/collect',
      app: {
        name: 'garage-admin-console',
        version: '1.0.0',
        environment: 'production',
      },
      instrumentations: [
        ...getWebInstrumentations(),
        new TracingInstrumentation(),
      ],
      sessionTracking: {
        enabled: true,
        persistent: true,
      },
      batching: {
        sendTimeout: 1000,
      },
      ignoreErrors: [/ResizeObserver/],
    })
  }
}
