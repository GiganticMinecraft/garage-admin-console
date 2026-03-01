# Garage Admin Console Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Garage object storage の Admin API + S3 API フル管理 Web UI を構築する。

**Architecture:** Go 1.26 バックエンド (garage-admin-sdk-golang v2.1.0 + aws-sdk-go-v2) と React 19 フロントエンド (shadcn/ui + Tailwind v4) を分離デプロイ。Nginx (OTel Module) がフロントの SPA 配信と API リバプロを担当。GitHub OAuth で GiganticMinecraft org の Garage Admin Team に制限。Faro + OTel で End-to-End 分散トレーシング。

**Tech Stack:** Go 1.26, React 19, Vite, shadcn/ui, Tailwind CSS v4, TanStack Router/Query, nginx:1.27-alpine-otel, Grafana Faro, OpenTelemetry, git.deuxfleurs.fr/garage-sdk/garage-admin-sdk-golang v2.1.0, aws-sdk-go-v2

**Reference:** Design doc at `docs/plans/2026-03-01-garage-admin-console-design.md`

**Reference project:** `/Users/inductor/krew-index-visualizer` — Faro + OTel + Nginx の実装パターン

---

## Phase 1: Backend Scaffolding

### Task 1: Go モジュール初期化

**Files:**
- Create: `backend/go.mod`
- Create: `backend/main.go`
- Create: `backend/.gitignore`

**Step 1: Go module を初期化**

```bash
cd /Users/inductor/garage-admin-console
mkdir -p backend
cd backend
go mod init github.com/GiganticMinecraft/garage-admin-console/backend
```

**Step 2: main.go を作成**

```go
package main

import (
	"log/slog"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)

	r.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"ok"}`))
	})

	addr := ":8080"
	slog.Info("starting server", "addr", addr)
	if err := http.ListenAndServe(addr, r); err != nil {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
}
```

**Step 3: 依存を追加**

```bash
go get github.com/go-chi/chi/v5
go mod tidy
```

**Step 4: ビルド確認**

Run: `go build -o /dev/null .`
Expected: 成功 (出力なし)

**Step 5: .gitignore 作成**

```
garage-admin-console
```

**Step 6: Commit**

```bash
git add backend/
git commit -m "feat(backend): Go モジュール初期化 + health エンドポイント"
```

---

### Task 2: OTel 初期化

**Files:**
- Create: `backend/otel.go`
- Modify: `backend/main.go`

**Reference:** `/Users/inductor/krew-index-visualizer/backend/otel.go`

**Step 1: otel.go を作成**

krew-index-visualizer と同じパターン:
- `otlptracehttp.New(ctx)` で OTLP HTTP エクスポーター
- `resource.New` でサービス名 `garage-admin-console`
- `sdktrace.NewTracerProvider` + `baggagecopy` プロセッサー
- `propagation.TraceContext{}` + `propagation.Baggage{}` プロパゲーター

```go
package main

import (
	"context"
	"log"

	"go.opentelemetry.io/contrib/processors/baggagecopy"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

func initTracer(ctx context.Context) (func(), error) {
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceNameKey.String("garage-admin-console"),
		),
	)
	if err != nil {
		return nil, err
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
		sdktrace.WithSpanProcessor(baggagecopy.NewSpanProcessor(baggagecopy.AllowAllMembers)),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return func() {
		if err := tp.Shutdown(ctx); err != nil {
			log.Printf("error shutting down tracer: %v", err)
		}
	}, nil
}
```

**Step 2: main.go に OTel 統合 + otelhttp ミドルウェア**

```go
// main() の冒頭に追加
shutdown, err := initTracer(context.Background())
if err != nil {
	slog.Error("failed to init tracer", "error", err)
	os.Exit(1)
}
defer shutdown()

// router をラップ
handler := otelhttp.NewHandler(r, "garage-admin-console")
http.ListenAndServe(addr, handler)
```

**Step 3: 依存追加 + ビルド確認**

```bash
go get go.opentelemetry.io/otel
go get go.opentelemetry.io/otel/sdk
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp
go get go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
go get go.opentelemetry.io/contrib/processors/baggagecopy
go mod tidy
go build -o /dev/null .
```

**Step 4: Commit**

```bash
git add backend/
git commit -m "feat(backend): OpenTelemetry トレーシング初期化"
```

---

### Task 3: GitHub OAuth 認証

**Files:**
- Create: `backend/auth.go`
- Modify: `backend/main.go`

**Step 1: auth.go を作成**

以下の機能を実装:
- `GET /api/auth/login` — ランダム `state` パラメータ生成 → セッションに保存 → GitHub OAuth 認可ページにリダイレクト
- `GET /api/auth/callback` — `state` 検証 (CSRF防止) → コード受取 → トークン交換 → org team チェック → セッション ID 再生成 (session fixation 防止) → セッション Cookie 発行
- `GET /api/auth/me` — 現在のセッションユーザー情報を返却
- `POST /api/auth/logout` — セッション破棄
- `AuthMiddleware` — セッション Cookie 検証ミドルウェア
- `CSRFMiddleware` — Mutation リクエスト (POST/PUT/DELETE) に対して `X-Requested-With: XMLHttpRequest` ヘッダーを検証。JSON ボディのエンドポイントは追加で `Content-Type: application/json` を検証。ファイルアップロード (`/api/objects/*/upload`) は `multipart/form-data` を許可

セッション Cookie 設定:
- `Secure: true`, `HttpOnly: true`, `SameSite: Lax`, `MaxAge: 3600`

環境変数:
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_ORG` (default: `GiganticMinecraft`)
- `GITHUB_TEAM_SLUG` (default: Garage Admin Team のスラッグ)
- `SESSION_SECRET` (Cookie 暗号化キー)
- `BASE_URL` (OAuth callback URL のベース、例: `https://garage-admin.onp.admin.seichi.click`)

使用ライブラリ:
- `golang.org/x/oauth2` + `golang.org/x/oauth2/github`
- `github.com/gorilla/sessions` (Cookie セッションストア)

GitHub API 呼び出し (otelhttp.NewTransport でトレース):
1. `GET https://api.github.com/user` → ユーザー情報
2. `GET https://api.github.com/orgs/{org}/teams/{team}/memberships/{username}` → team 所属チェック

**Step 2: main.go にルート追加**

```go
// 認証不要 (OAuth フロー用)
r.Get("/api/auth/login", handleLogin)
r.Get("/api/auth/callback", handleCallback)

// 認証が必要なルートグループ
r.Group(func(r chi.Router) {
	r.Use(authMiddleware)
	r.Use(csrfMiddleware) // POST/PUT/DELETE に X-Requested-With を検証 (JSON エンドポイントは Content-Type も検証、upload は multipart 許可)

	r.Get("/api/auth/me", handleMe)
	r.Post("/api/auth/logout", handleLogout)
	// ここに保護されたルートを追加
})
```

**Step 3: 依存追加 + ビルド確認**

```bash
go get golang.org/x/oauth2
go get github.com/gorilla/sessions
go mod tidy
go build -o /dev/null .
```

**Step 4: Commit**

```bash
git add backend/
git commit -m "feat(backend): GitHub OAuth 認証 + org team チェック + CSRF 保護"
```

---

### Task 4: Cluster エンドポイント

**Files:**
- Create: `backend/handler_cluster.go`
- Create: `backend/garage.go` (Garage Admin SDK クライアント初期化)
- Modify: `backend/main.go`

**Step 1: garage.go — Admin SDK クライアント初期化**

環境変数:
- `GARAGE_ADMIN_ENDPOINT` (default: `http://garage.garage.svc.cluster.local:3903`)
- `GARAGE_ADMIN_TOKEN`

Admin API ドキュメント: https://garagehq.deuxfleurs.fr/api/garage-admin-v2.html

```go
package main

import (
	"net/http"
	"os"

	garage "git.deuxfleurs.fr/garage-sdk/garage-admin-sdk-golang"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

func newGarageClient() *garage.APIClient {
	cfg := garage.NewConfiguration()
	cfg.Servers = garage.ServerConfigurations{
		{URL: os.Getenv("GARAGE_ADMIN_ENDPOINT")},
	}
	cfg.HTTPClient = &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport),
	}
	cfg.AddDefaultHeader("Authorization", "Bearer "+os.Getenv("GARAGE_ADMIN_TOKEN"))
	return garage.NewAPIClient(cfg)
}
```

依存追加:
```bash
go get git.deuxfleurs.fr/garage-sdk/garage-admin-sdk-golang
```

**Step 2: handler_cluster.go を作成**

```go
// GET /api/cluster/health
// GET /api/cluster/status
// GET /api/cluster/layout
// POST /api/cluster/layout
```

Admin API エンドポイント:
- `GET /health` → クラスタヘルス
- `GET /status` → ノード一覧 + ストレージ統計
- `GET /layout` → レイアウト
- `POST /layout` → レイアウト変更

**Step 3: main.go にルート追加**

```go
r.Group(func(r chi.Router) {
	r.Use(authMiddleware)
	r.Route("/api/cluster", func(r chi.Router) {
		r.Get("/health", handleClusterHealth)
		r.Get("/status", handleClusterStatus)
		r.Get("/layout", handleClusterLayout)
		r.Post("/layout", handleApplyLayout)
	})
})
```

**Step 4: ビルド確認 + Commit**

```bash
go mod tidy && go build -o /dev/null .
git add backend/
git commit -m "feat(backend): Cluster 管理エンドポイント (health, status, layout)"
```

---

### Task 5: Bucket エンドポイント

**Files:**
- Create: `backend/handler_buckets.go`
- Modify: `backend/main.go`

**Step 1: handler_buckets.go を作成**

Admin API エンドポイント:
- `GET /bucket?list` → バケット一覧
- `POST /bucket` → バケット作成
- `GET /bucket?id=<id>` → バケット詳細
- `PUT /bucket?id=<id>` → バケット更新
- `DELETE /bucket?id=<id>` → バケット削除
- `POST /bucket/allow` → キーにバケット権限付与
- `POST /bucket/deny` → 権限剥奪

ハンドラー:
```go
// GET    /api/buckets
// POST   /api/buckets
// GET    /api/buckets/{id}
// PUT    /api/buckets/{id}
// DELETE /api/buckets/{id}
// POST   /api/buckets/{id}/keys
// DELETE /api/buckets/{id}/keys/{keyId}
```

**Step 2: ルート追加 + ビルド確認 + Commit**

```bash
git commit -m "feat(backend): Bucket CRUD エンドポイント"
```

---

### Task 6: Key エンドポイント

**Files:**
- Create: `backend/handler_keys.go`
- Modify: `backend/main.go`

Admin API エンドポイント:
- `GET /key?list` → キー一覧
- `POST /key` → キー作成
- `GET /key?id=<id>` → キー詳細
- `POST /key?id=<id>` → キー更新 (name変更等)
- `DELETE /key?id=<id>` → キー削除
- `POST /key/import` → キーインポート

ハンドラー:
```go
// GET    /api/keys
// POST   /api/keys
// GET    /api/keys/{id}
// PUT    /api/keys/{id}
// DELETE /api/keys/{id}
```

**Commit:**

```bash
git commit -m "feat(backend): Key 管理エンドポイント"
```

---

### Task 7: Object エンドポイント (S3 プロキシ)

**Files:**
- Create: `backend/handler_objects.go`
- Create: `backend/s3.go` (aws-sdk-go-v2 S3 クライアント初期化)
- Modify: `backend/main.go`

**Step 1: s3.go — S3 クライアント初期化**

環境変数:
- `GARAGE_S3_ENDPOINT` (default: `http://garage.garage.svc.cluster.local:3900`)
- `GARAGE_S3_ACCESS_KEY`
- `GARAGE_S3_SECRET_KEY`
- `GARAGE_S3_REGION` (default: `seichi-cloud`)

aws-sdk-go-v2 の `s3.Client` を初期化。PathStyle 有効。
outbound HTTP クライアントに `otelhttp.NewTransport` を設定してトレース。

**Step 2: handler_objects.go を作成**

```go
// GET    /api/objects/{bucket}/list?prefix=&delimiter=  → s3:ListObjectsV2
// GET    /api/objects/{bucket}/download?key=             → s3:GetObject (プロキシ)
// POST   /api/objects/{bucket}/upload                    → s3:PutObject (multipart form)
// DELETE /api/objects/{bucket}?key=                       → s3:DeleteObject
```

ListObjectsV2 はページネーション対応。
Download は `Content-Disposition: attachment` でプロキシ。
Upload は `multipart/form-data` を受けて S3 に PutObject。
Object key はクエリパラメータで受け渡す: `r.URL.Query().Get("key")` で取得 (Go 標準ライブラリが自動デコードするため明示的な `url.QueryUnescape` は不要。二重デコードを防ぐ)。

**Step 3: ビルド確認 + Commit**

```bash
git commit -m "feat(backend): Object ブラウズ/アップロード/ダウンロード/削除"
```

---

### Task 8: Worker エンドポイント

**Files:**
- Create: `backend/handler_workers.go`
- Modify: `backend/main.go`

Admin API: `GET /worker?list` → ワーカー一覧

```go
// GET /api/workers
```

**Commit:**

```bash
git commit -m "feat(backend): Worker 一覧エンドポイント"
```

---

### Task 9: Backend Dockerfile

**Files:**
- Create: `backend/Dockerfile`

**Reference:** `/Users/inductor/krew-index-visualizer/backend/Dockerfile`

```dockerfile
FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags '-s' -o /garage-admin-console .

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=builder /garage-admin-console /garage-admin-console
EXPOSE 8080
ENTRYPOINT ["/garage-admin-console"]
```

**Commit:**

```bash
git commit -m "feat(backend): Dockerfile 追加"
```

---

## Phase 2: Frontend Scaffolding

### Task 10: Vite + React プロジェクト初期化

**Files:**
- Create: `frontend/` (Vite scaffold)
- Create: `frontend/.gitignore`

**Step 1: Vite プロジェクト作成**

```bash
cd /Users/inductor/garage-admin-console
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install
```

**Step 2: Tailwind CSS v4 セットアップ**

```bash
npm install tailwindcss @tailwindcss/vite
```

`vite.config.ts` に Tailwind プラグイン追加:
```typescript
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
```

`src/index.css` の先頭:
```css
@import "tailwindcss";
```

**Step 3: shadcn/ui セットアップ**

```bash
npx shadcn@latest init
```

プロンプトに回答:
- Style: Default
- Base color: Neutral
- CSS variables: Yes

**Step 4: TanStack Router + Query インストール**

```bash
npm install @tanstack/react-router @tanstack/react-query
```

**Step 5: ビルド確認**

```bash
npm run build
```

**Step 6: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): Vite + React + Tailwind v4 + shadcn/ui 初期化"
```

---

### Task 11: Faro + トレーシング設定

**Files:**
- Modify: `frontend/src/main.tsx`
- Create: `frontend/src/faro.ts`

**Reference:** `/Users/inductor/krew-index-visualizer/frontend/src/main.tsx`

**Step 1: Faro 依存追加**

```bash
npm install @grafana/faro-web-sdk @grafana/faro-web-tracing
```

**Step 2: faro.ts を作成**

```typescript
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
```

**Step 3: main.tsx で setupFaro() を呼び出し**

```typescript
import { setupFaro } from './faro'
setupFaro()
// ... ReactDOM.createRoot
```

**Step 4: ビルド確認 + Commit**

```bash
npm run build
git commit -m "feat(frontend): Grafana Faro + TracingInstrumentation 設定"
```

---

### Task 12: TanStack Router セットアップ + レイアウト

**Files:**
- Create: `frontend/src/routes/__root.tsx`
- Create: `frontend/src/routes/index.tsx`
- Create: `frontend/src/router.ts`
- Create: `frontend/src/components/sidebar.tsx`
- Modify: `frontend/src/main.tsx`

**Step 1: ルートレイアウト (__root.tsx)**

shadcn/ui の sidebar + header レイアウト。
ナビゲーション: Dashboard, Buckets, Keys, Layout, Workers

**Step 2: router.ts**

TanStack Router のルーター定義。

**Step 3: index.tsx (ダッシュボード)**

仮のダッシュボード画面。後のタスクで実装。

**Step 4: main.tsx に RouterProvider 追加**

**Step 5: ビルド確認 + Commit**

```bash
git commit -m "feat(frontend): TanStack Router + サイドバーレイアウト"
```

---

### Task 13: API クライアント + 認証フロー

**Files:**
- Create: `frontend/src/api.ts`
- Create: `frontend/src/routes/login.tsx`
- Modify: `frontend/src/routes/__root.tsx`

**Step 1: api.ts — fetch ラッパー**

```typescript
const BASE = '/api'

// JSON API 用 fetch ラッパー
async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('X-Requested-With', 'XMLHttpRequest')

  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  if (res.status === 401) {
    window.location.href = `${BASE}/auth/login`
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

// ファイルアップロード用 (Content-Type は FormData が自動設定)
async function uploadFile(bucket: string, file: File): Promise<void> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/objects/${bucket}/upload`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  })
  if (!res.ok) throw new Error(`Upload error: ${res.status}`)
}
```

fetch は Faro の TracingInstrumentation が自動的に traceparent を付与する。
`X-Requested-With: XMLHttpRequest` はすべての mutation リクエストに付与 (CSRF 保護)。
JSON エンドポイントは `Content-Type: application/json` も付与。アップロードは `FormData` が `multipart/form-data` を自動設定するため `Content-Type` は明示しない。
Object key を含むリクエストは `encodeURIComponent(key)` でクエリパラメータに載せる。

**Step 2: login.tsx — ログインページ**

GitHub ログインボタン → `/api/auth/login` にリダイレクト

**Step 3: __root.tsx で /api/auth/me を呼んで認証チェック**

未認証 → login ページ、認証済み → メインレイアウト

**Step 4: ビルド確認 + Commit**

```bash
git commit -m "feat(frontend): API クライアント + GitHub 認証フロー"
```

---

### Task 14: ダッシュボード画面

**Files:**
- Modify: `frontend/src/routes/index.tsx`
- Modify: `frontend/src/api.ts`

shadcn/ui の Card コンポーネントを使用:
- クラスタヘルス表示 (GET /api/cluster/health)
- ノード一覧テーブル (GET /api/cluster/status)
- ストレージ使用量表示

TanStack Query でデータフェッチ。

**Commit:**

```bash
git commit -m "feat(frontend): ダッシュボード (クラスタヘルス + ノード一覧)"
```

---

### Task 15: バケット管理画面

**Files:**
- Create: `frontend/src/routes/buckets.tsx`
- Create: `frontend/src/routes/buckets.$id.tsx`
- Modify: `frontend/src/api.ts`

**buckets.tsx:**
- バケット一覧テーブル (shadcn/ui Table)
- 作成ダイアログ (Dialog + Form)
- 削除ボタン (確認ダイアログ付き)

**buckets.$id.tsx:**
- バケット詳細情報
- オブジェクトブラウザ (ツリー/リスト表示、prefix ナビゲーション)
- アップロードボタン (ドラッグ&ドロップ対応)
- ダウンロード/削除アクション
- キー権限管理セクション

**Commit:**

```bash
git commit -m "feat(frontend): バケット一覧 + 詳細 + オブジェクトブラウザ"
```

---

### Task 16: キー管理画面

**Files:**
- Create: `frontend/src/routes/keys.tsx`
- Create: `frontend/src/routes/keys.$id.tsx`
- Modify: `frontend/src/api.ts`

**keys.tsx:**
- キー一覧テーブル
- 作成ダイアログ

**keys.$id.tsx:**
- キー詳細 (ID, Secret 表示/コピー)
- 紐付きバケット権限の一覧・編集

**Commit:**

```bash
git commit -m "feat(frontend): キー管理画面"
```

---

### Task 17: レイアウト + ワーカー画面

**Files:**
- Create: `frontend/src/routes/layout.tsx`
- Create: `frontend/src/routes/workers.tsx`
- Modify: `frontend/src/api.ts`

**layout.tsx:**
- 現在のレイアウト表示 (ノード → ゾーン/容量のマッピング)
- 変更フォーム + 適用ボタン (確認ダイアログ付き)

**workers.tsx:**
- ワーカー一覧テーブル (名前、状態、進捗)

**Commit:**

```bash
git commit -m "feat(frontend): レイアウト管理 + ワーカー一覧画面"
```

---

### Task 18: Frontend Dockerfile + Nginx 設定

**Files:**
- Create: `frontend/Dockerfile`
- Create: `frontend/nginx.conf`

**Reference:** `/Users/inductor/krew-index-visualizer/frontend/Dockerfile` and `nginx.conf`

**Step 1: nginx.conf**

```nginx
load_module modules/ngx_otel_module.so;

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout 65;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;

    otel_exporter {
        endpoint alloy.monitoring.svc.cluster.local:4317;
    }
    otel_service_name garage-admin-console-frontend;

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
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }

        location / {
            root /usr/share/nginx/html;
            try_files $uri /index.html;
        }
    }
}
```

**Step 2: Dockerfile**

```dockerfile
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine-otel
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
```

**Step 3: Commit**

```bash
git commit -m "feat(frontend): Dockerfile + Nginx OTel 設定"
```

---

## Phase 3: CI/CD + K8s Deployment

### Task 19: GitHub Actions CI

**Files:**
- Create: `.github/workflows/build.yaml`

**Step 1: build.yaml を作成**

Jobs:
1. `lint-and-test-backend` — Go lint (golangci-lint) + test
2. `lint-and-test-frontend` — npm lint + type check
3. `build-backend` — Docker build (+ push on main)
4. `build-frontend` — Docker build (+ push on main)

イメージ push は `github.ref == 'refs/heads/main'` のみ。
タグ: `sha-<short-hash>` (docker/metadata-action)

**Step 2: Commit**

```bash
git commit -m "ci: GitHub Actions ワークフロー追加"
```

---

### Task 20: seichi_infra に K8s マニフェスト追加

**注意:** このタスクは seichi_infra リポジトリ側で実施。

**Files (in seichi_infra):**
- Create: `seichi-onp-k8s/manifests/seichi-kubernetes/apps/cluster-wide-apps/garage-admin/deployment-api.yaml`
- Create: `seichi-onp-k8s/manifests/seichi-kubernetes/apps/cluster-wide-apps/garage-admin/deployment-ui.yaml`
- Create: `seichi-onp-k8s/manifests/seichi-kubernetes/apps/cluster-wide-apps/garage-admin/service.yaml`
- Create: `seichi-onp-k8s/manifests/seichi-kubernetes/apps/cluster-wide-apps/garage-admin/kustomization.yaml`
- Modify: `seichi-onp-k8s/manifests/seichi-kubernetes/apps/cluster-wide-apps/app-of-other-apps/` (ArgoCD Application 追加)
- Modify: `seichi-onp-k8s/manifests/seichi-kubernetes/apps/cloudflared-tunnel-exits/http-exits.yaml` (Tunnel exit 追加)
- Modify: `terraform/onp_cluster_secrets.tf` (GitHub OAuth secret, Garage Admin token, S3 credentials)
- Modify: `terraform/main.tf` (新しい variable 追加)

K8s リソース:
- `Deployment/garage-admin-api` — Go サーバー (1 replica)
- `Deployment/garage-admin-ui` — Nginx + SPA (1 replica)
- `Service/garage-admin-ui` — ClusterIP (Cloudflare Tunnel target)
- `Service/garage-admin-api` — ClusterIP (Nginx からのみ)
- `Secret/garage-admin-github-oauth` — CLIENT_ID, CLIENT_SECRET, SESSION_SECRET
- `Secret/garage-admin-token` — Garage Admin API bearer token
- `Secret/garage-admin-s3` — GARAGE_S3_ACCESS_KEY, GARAGE_S3_SECRET_KEY (Object API 用)
- Cloudflare Tunnel exit: `garage-admin.onp.admin.seichi.click`

**Commit (in seichi_infra):**

```bash
git commit -m "feat: garage-admin-console K8s マニフェスト + Cloudflare Tunnel 追加"
```

---

## Implementation Order Summary

| Phase | Task | Description |
|-------|------|-------------|
| 1 | 1 | Go module 初期化 + health |
| 1 | 2 | OTel 初期化 |
| 1 | 3 | GitHub OAuth 認証 |
| 1 | 4 | Cluster エンドポイント |
| 1 | 5 | Bucket エンドポイント |
| 1 | 6 | Key エンドポイント |
| 1 | 7 | Object エンドポイント (S3) |
| 1 | 8 | Worker エンドポイント |
| 1 | 9 | Backend Dockerfile |
| 2 | 10 | Frontend 初期化 (Vite + React + Tailwind v4 + shadcn/ui) |
| 2 | 11 | Faro + トレーシング |
| 2 | 12 | Router + レイアウト |
| 2 | 13 | API クライアント + 認証フロー |
| 2 | 14 | ダッシュボード画面 |
| 2 | 15 | バケット管理 + オブジェクトブラウザ |
| 2 | 16 | キー管理画面 |
| 2 | 17 | レイアウト + ワーカー画面 |
| 2 | 18 | Frontend Dockerfile + Nginx |
| 3 | 19 | GitHub Actions CI |
| 3 | 20 | seichi_infra K8s マニフェスト |
