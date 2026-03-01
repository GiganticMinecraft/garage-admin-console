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
| Frontend | React 19, Vite, shadcn/ui, Tailwind CSS v4, TanStack Router, TanStack Query |
| Backend | Go 1.26, chi, aws-sdk-go-v2 |
| Web Server | nginx:1.27-alpine-otel |
| Auth | GitHub OAuth (org team check) |
| Observability | Grafana Faro (FE), OpenTelemetry (BE + Nginx) |
| CI | GitHub Actions -> ghcr.io |

## Pages

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/` | Cluster health, node list |
| Buckets | `/buckets` | Bucket CRUD |
| Bucket Detail | `/buckets/:id` | Object browser, upload/download/delete, key permissions |
| Keys | `/keys` | Access key list, create/delete |
| Key Detail | `/keys/:id` | Key info, bucket permissions |
| Layout | `/layout` | Cluster layout view/modify/apply |
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

## Deployment

K8s manifests are managed in [seichi_infra](https://github.com/GiganticMinecraft/seichi_infra) under `seichi-onp-k8s/manifests/seichi-kubernetes/apps/cluster-wide-apps/garage-admin/`.

Secrets are provisioned via Terraform. See `terraform/main.tf` and `terraform/onp_cluster_secrets.tf` in seichi_infra.
