# Garage Admin Console

[Garage](https://garagehq.deuxfleurs.fr/) object storage cluster の管理 Web UI。
Admin API (バケット・キー・クラスタ管理) と S3 API (オブジェクト操作) を単一のアプリケーションで提供する。

## Architecture

```
[Browser: React + Faro]
    | HTTPS
[Cloudflare Tunnel]
    |
[Nginx (nginx:1.27-alpine-otel)]
    |-- /          -> React SPA (static files)
    |-- /collect   -> Alloy Faro Receiver (:12347)
    +-- /api/*     -> Go API Server (:8080)
                        |-- GitHub OAuth
                        |-- Garage Admin API (:3903)
                        +-- Garage S3 API (:3900)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite, shadcn/ui, Tailwind CSS v4, TanStack Router, TanStack Query, ECharts |
| Backend | Go 1.26, chi, aws-sdk-go-v2 |
| Web Server | nginx:1.27-alpine-otel |
| Auth | GitHub OAuth (org team check) |
| Observability | Grafana Faro (FE), OpenTelemetry (BE + Nginx) |
| CI | GitHub Actions -> ghcr.io |

## Pages

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/` | Cluster health, node list, storage charts |
| Buckets | `/buckets` | Bucket CRUD |
| Bucket Detail | `/buckets/:id` | Object browser, upload/download/delete, key permissions |
| Keys | `/keys` | Access key list, create/delete |
| Key Detail | `/keys/:id` | Key info, bucket permissions |
| Layout | `/layout` | Cluster layout view/modify/apply |
| Blocks | `/blocks` | Block error list, info, purge, resync |
| Repair | `/repair` | Repair operations, scrub commands |
| Workers | `/workers` | Background worker list (read-only) |

## Development

### Backend

```bash
cd backend
go mod download
go build -o garage-admin-console .
```

Environment variables:

| Variable | Description |
|----------|-------------|
| `GARAGE_ADMIN_ENDPOINT` | Garage Admin API URL (default: `http://localhost:3903`) |
| `GARAGE_ADMIN_TOKEN` | Garage Admin API bearer token |
| `GARAGE_S3_ENDPOINT` | Garage S3 API URL (default: `http://localhost:3900`) |
| `GARAGE_S3_ACCESS_KEY` | S3 access key |
| `GARAGE_S3_SECRET_KEY` | S3 secret key |
| `GARAGE_S3_REGION` | S3 region (default: `seichi-cloud`) |
| `GARAGE_S3_PUBLIC_ENDPOINT` | Optional. S3 URL shown to operators in the key page's "S3 接続情報" dialog (default: `GARAGE_S3_ENDPOINT`) |
| `GITHUB_CLIENT_ID` | GitHub OAuth Client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth Client Secret |
| `GITHUB_ORG` | GitHub org for team check (default: `GiganticMinecraft`) |
| `GITHUB_TEAM_SLUG` | GitHub team slug for access control |
| `SESSION_SECRET` | Cookie encryption key |
| `BASE_URL` | OAuth callback base URL |

### Frontend

```bash
cd frontend
npm ci
npm run dev
```

### Docker

```bash
# Backend
docker build -t garage-admin-console-backend backend/

# Frontend
docker build -t garage-admin-console-frontend frontend/
```

## Observability

### 監査ログ

backend は stderr に JSON (slog) でログを出す。全リクエストに `msg="request"` の行 (`user`, `method`, `path`, `status`, `duration_ms`, `bytes`, `trace_id`, `span_id`) が出て、`user` はセッションの GitHub ログイン名 (未認証なら省略)。加えて変更系リクエスト (POST / PUT / PATCH / DELETE。`/api/auth/*` は除く) ごとに `msg="audit"` の INFO 行が出る。フィールドは `user`、`method`、`path`、`route` (chi のルートパターン。例 `/api/buckets/{id}/keys/{kid}`)、`status`、`duration_ms`、`trace_id`、`params` (URL パラメータ)、`query` (`prefix` / `delimiter` / `key` / `accessKeyId` / `overwrite` / `showSecretKey` だけの許可リスト)、`detail` (操作ごとの要約: repair の `repairType` (Scrub は `scrub:start`)、worker 変数の `variable` と `allNodes` (値は記録しない)、snapshot の `allNodes`、オブジェクト一括削除の `keyCount` と先頭 5 件の `keys`、ブロック purge の `hashCount` と先頭 5 件の `hashes`、レイアウト apply / revert / skip-dead-nodes の `version`、cleanup-uploads の `olderThanSecs`、キー権限と console-access の `read` / `write` / `owner`)、`garageErrors` (後述)。ハンドラが panic しても、Recoverer が返す 500 で request / audit の両方の行が出る。ログインとログアウトはハンドラが `msg="audit"`、`event="login"` / `"logout"`、`user` の行を出す。`status` は転送レベルの HTTP status で、Garage の MultiResponse が一部または全部のノードで失敗しても 200 になる。Garage 側の成否は応答の `error` map を見る。応答 (先頭 4 KiB) の `error` map が空でなければ `garageErrors: true` が付く。リクエストボディ (`detail` 用に先頭 4 KiB だけ読む例外を除く)、Authorization / Cookie ヘッダ、トークンやシークレットは記録しない。Pod が入れ替わってもログは Loki に残る (k8s-monitoring の Alloy が送っている)。`{namespace="garage-admin", container="garage-admin-api"} | json | msg="audit"` で絞れば、誰がいつどのリソースを変更したかを追える。

## Deployment

K8s manifests are managed in [seichi_infra](https://github.com/GiganticMinecraft/seichi_infra) under `seichi-onp-k8s/manifests/seichi-kubernetes/apps/cluster-wide-apps/garage-admin/`.

Secrets are provisioned via Terraform. See `terraform/main.tf` and `terraform/onp_cluster_secrets.tf` in seichi_infra.
