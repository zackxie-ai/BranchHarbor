#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for command in docker git node pnpm curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required. See README.md for prerequisites." >&2
    exit 1
  fi
done

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop is not running." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

cat <<'WARNING'
CloudAgent v0.1.0-alpha uses local development credentials and OpenBao dev mode.
Do not expose this stack to the public internet. Read SECURITY.md first.
WARNING

set -a
source .env
set +a

mkdir -p infra/data

echo "Starting CloudAgent infrastructure..."
docker compose --env-file .env -f infra/compose.yml up -d --wait --wait-timeout 180

echo "Waiting for Gitea..."
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${GITEA_HTTP_PORT}/api/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -fsS "http://127.0.0.1:${GITEA_HTTP_PORT}/api/healthz" >/dev/null 2>&1; then
  echo "Gitea did not become healthy. Run 'make logs' for details." >&2
  exit 1
fi

if ! docker compose --env-file .env -f infra/compose.yml exec -T gitea \
  gitea admin user list 2>/dev/null | grep -q "${GITEA_ADMIN_USER}"; then
  docker compose --env-file .env -f infra/compose.yml exec -T gitea \
    gitea admin user create \
      --username "${GITEA_ADMIN_USER}" \
      --password "${GITEA_ADMIN_PASSWORD}" \
      --email "${GITEA_ADMIN_EMAIL}" \
      --admin \
      --must-change-password=false
  echo "Created Gitea admin user ${GITEA_ADMIN_USER}"
fi

docker compose --env-file .env -f infra/compose.yml exec -T gitea \
  gitea admin user change-password \
    --username "${GITEA_ADMIN_USER}" \
    --password "${GITEA_ADMIN_PASSWORD}" \
    --must-change-password=false >/dev/null

bash scripts/init-gitea-repo.sh

echo "Initializing OpenBao development KV mount..."
docker compose --env-file .env -f infra/compose.yml exec -T \
  -e BAO_ADDR=http://127.0.0.1:8200 \
  -e BAO_TOKEN="${OPENBAO_DEV_ROOT_TOKEN}" \
  openbao bao secrets enable -path=cloudagent kv-v2 >/dev/null 2>&1 || true
docker compose --env-file .env -f infra/compose.yml exec -T \
  -e BAO_ADDR=http://127.0.0.1:8200 \
  -e BAO_TOKEN="${OPENBAO_DEV_ROOT_TOKEN}" \
  openbao bao kv put cloudagent/bootstrap initialized=true >/dev/null

echo
echo "CloudAgent infrastructure is ready."
echo "Gitea:      http://localhost:${GITEA_HTTP_PORT}"
echo "OpenBao:    http://localhost:${OPENBAO_PORT}"
echo "PostgreSQL: localhost:${POSTGRES_PORT}"
