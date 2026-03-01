# Garage Admin Console - Design Document

Date: 2026-03-01

## Overview

Garage object storage cluster のフル管理 Web UI。
Admin API (バケット・キー・クラスタ管理) と S3 API (オブジェクト操作) の全機能を単一のアプリケーションで提供する。

## Requirements

- GiganticMinecraft org のインフラ管理者のみが利用
- GitHub OAuth 認証 (Garage Admin Team 所属チェック)
- Garage Admin API + S3 API の全機能を Web UI で操作可能
- Frontend → Nginx → Backend → Garage の End-to-End 分散トレーシング
- K8s デプロイ + Cloudflare Tunnel で公開

## Architecture

```
[Browser: React + Faro]
    │ HTTPS
[Cloudflare Tunnel]
    │
[Nginx (nginx:1.27-alpine-otel)]
    ├── /          → React SPA (静的ファイル配信)
    ├── /collect   → Alloy Faro Receiver (:12347)
    └── /api/*     → Go API Server (:8080)
                        ├── GitHub OAuth
                        ├── Garage Admin API (:3903)
                        └── Garage S3 API (:3900)
```

Frontend と Backend は別コンテナで分離デプロイ。
Nginx が SPA 配信 + API リバースプロキシ + OTel トレース伝播を担当する。

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite, shadcn/ui, Tailwind CSS v4, TanStack Router, TanStack Query |
| Backend | Go 1.26, garage-admin-sdk-golang v2.1.0, aws-sdk-go-v2 |
| Web Server | nginx:1.27-alpine-otel (OTel Module + Real IP) |
| Auth | GitHub OAuth → GiganticMinecraft org Garage Admin Team check |
| Observability | Grafana Faro (FE), OpenTelemetry (BE + Nginx) → Alloy → Tempo |
| Deploy | K8s (2 Deployments) + Cloudflare Tunnel |
| Images | ghcr.io/giganticminecraft/garage-admin-console-{frontend,backend} |

## Repository Structure

```
garage-admin-console/
├── frontend/
│   ├── src/
│   │   ├── main.tsx              # Faro init + React entry
│   │   ├── api.ts                # API client
│   │   ├── routes/               # TanStack Router pages
│   │   │   ├── __root.tsx
│   │   │   ├── index.tsx         # Dashboard
│   │   │   ├── buckets.tsx       # Bucket list
│   │   │   ├── buckets.$id.tsx   # Bucket detail + object browser
│   │   │   ├── keys.tsx          # Key list
│   │   │   ├── keys.$id.tsx      # Key detail
│   │   │   ├── layout.tsx        # Cluster layout
│   │   │   └── workers.tsx       # Workers
│   │   └── components/           # Shared UI components
│   ├── package.json
│   ├── vite.config.ts
│   ├── nginx.conf
│   └── Dockerfile                # node:24 build → nginx:1.27-alpine-otel
├── backend/
│   ├── main.go                   # HTTP server + chi router
│   ├── otel.go                   # OTel tracer init
│   ├── auth.go                   # GitHub OAuth + session management
│   ├── handler_cluster.go        # /api/cluster/* handlers
│   ├── handler_buckets.go        # /api/buckets/* handlers
│   ├── handler_keys.go           # /api/keys/* handlers
│   ├── handler_objects.go        # /api/objects/* handlers
│   ├── handler_workers.go        # /api/workers/* handlers
│   ├── go.mod
│   └── Dockerfile                # golang:1.26 build → distroless
├── .github/workflows/
│   └── build.yaml
└── docs/plans/
```

## Pages

| Page | Path | Features |
|------|------|----------|
| Dashboard | `/` | Cluster health, node list, storage usage |
| Buckets | `/buckets` | Bucket CRUD, alias management |
| Bucket Detail | `/buckets/:id` | Object browser (tree view), upload/download/delete |
| Keys | `/keys` | Access key list, create/delete |
| Key Detail | `/keys/:id` | Key info, bucket permission editing |
| Layout | `/layout` | Cluster layout view/modify/apply |
| Workers | `/workers` | Background worker list and status |

## API Endpoints

### Auth

```
GET  /api/auth/login       GitHub OAuth redirect
GET  /api/auth/callback    OAuth callback → session creation
GET  /api/auth/me          Current user info
POST /api/auth/logout      Session destroy
```

### Cluster

```
GET  /api/cluster/health   Cluster health
GET  /api/cluster/status   Node list + storage stats
GET  /api/cluster/layout   Current layout
POST /api/cluster/layout   Apply layout change
```

### Buckets

```
GET    /api/buckets           List buckets
POST   /api/buckets           Create bucket
GET    /api/buckets/:id       Bucket detail
PUT    /api/buckets/:id       Update bucket (quota etc)
DELETE /api/buckets/:id       Delete bucket
POST   /api/buckets/:id/keys      Grant key permission
DELETE /api/buckets/:id/keys/:kid  Revoke key permission
```

### Keys

```
GET    /api/keys        List keys
POST   /api/keys        Create key
GET    /api/keys/:id    Key detail
PUT    /api/keys/:id    Update key
DELETE /api/keys/:id    Delete key
```

### Objects

```
GET    /api/objects/:bucket/list?prefix=&delimiter=  List objects
GET    /api/objects/:bucket/download?key=             Download (proxy)
POST   /api/objects/:bucket/upload                    Upload (multipart)
DELETE /api/objects/:bucket?key=                       Delete object
```

### Workers

```
GET /api/workers   List workers
```

## Authentication Flow

1. User visits the app → redirected to `/api/auth/login`
2. Go server redirects to GitHub OAuth authorization page
3. GitHub returns to `/api/auth/callback` with auth code
4. Go server exchanges code for token, calls GitHub API to check:
   - User belongs to `GiganticMinecraft` org
   - User is member of Garage Admin Team
5. If OK → create session cookie, redirect to `/`
6. If NG → return 403
7. All `/api/*` endpoints validate session cookie via middleware

## Distributed Tracing (End-to-End)

Trace ID is propagated across all layers using W3C Trace Context (`traceparent` header).

```
[Browser: Faro + TracingInstrumentation]
    │ fetch auto-instrumented with traceparent
    │ POST /collect → Nginx → Alloy Faro Receiver (:12347)
    ↓
[Nginx: otel_trace on, otel_trace_context propagate]
    │ OTLP gRPC → Alloy (:4317)
    ↓
[Go: otelhttp.NewHandler (server) + otelhttp.NewTransport (client)]
    ├── Garage Admin API requests traced
    ├── Garage S3 API requests traced
    └── GitHub API requests traced
    │ OTLP HTTP → Alloy (:4318)
    ↓
[Alloy → Tempo]
```

All spans share the same traceId, viewable as a single waterfall in Grafana.

### Nginx Config

```nginx
load_module modules/ngx_otel_module.so;

http {
    otel_exporter {
        endpoint alloy.monitoring.svc.cluster.local:4317;
    }
    otel_service_name garage-admin-ui;

    server {
        listen 80;
        otel_trace on;
        otel_trace_context propagate;

        location = /collect {
            limit_except POST { deny all; }
            proxy_pass http://alloy.monitoring.svc.cluster.local:12347;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }

        location /api/ {
            proxy_pass http://garage-admin-api:8080;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            set_real_ip_from 0.0.0.0/0;
            real_ip_header CF-Connecting-IP;
        }

        location / {
            root /usr/share/nginx/html;
            try_files $uri /index.html;
        }
    }
}
```

### Faro Initialization

```typescript
if (import.meta.env.PROD) {
  initializeFaro({
    url: '/collect',
    app: { name: 'garage-admin-console', version: '1.0.0', environment: 'production' },
    instrumentations: [
      ...getWebInstrumentations(),
      new TracingInstrumentation(),
    ],
    sessionTracking: { enabled: true, persistent: true },
    batching: { sendTimeout: 1000 },
  })
}
```

### Go OTel Initialization

Same pattern as krew-index-visualizer:
- `otlptracehttp` exporter
- `baggagecopy` span processor
- W3C TraceContext + Baggage propagators
- `otelhttp.NewHandler` for server instrumentation
- `otelhttp.NewTransport` for outbound HTTP client instrumentation

## Kubernetes Resources

- `Deployment/garage-admin-ui` — Nginx + React SPA (1 replica)
- `Deployment/garage-admin-api` — Go server (1 replica)
- `Service/garage-admin-ui` — ClusterIP, Cloudflare Tunnel target
- `Service/garage-admin-api` — ClusterIP (internal, Nginx → Go only)
- `Secret/garage-admin-github-oauth` — GitHub OAuth Client ID/Secret
- `Secret/garage-admin-token` — Garage Admin API token
- Cloudflare Tunnel exit for `garage-admin.onp.admin.seichi.click`

## Decisions

- **Unified app**: Admin API + S3 API in one app (users are infra admins only)
- **Separated deploy**: Frontend (Nginx) and Backend (Go) as 2 containers for flexibility
- **GitHub OAuth**: Team-based access control instead of Cloudflare Access
- **nginx:1.27-alpine-otel**: Pre-built OTel module image, no custom Nginx build needed
- **krew-index-visualizer pattern**: Proven Faro + OTel + Nginx setup reused
