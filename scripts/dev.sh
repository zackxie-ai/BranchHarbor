#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

set -a
source .env
set +a

export BRANCHHARBOR_ROOT="$ROOT_DIR"
export CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-3210}"
export DATABASE_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_USER}}"
export GITEA_BASE_URL="${GITEA_BASE_URL:-http://127.0.0.1:${GITEA_HTTP_PORT}}"

pnpm db:migrate
pnpm --filter @branchharbor/control-plane worker &
WORKER_PID=$!

cleanup() {
  kill "$WORKER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

pnpm --filter @branchharbor/control-plane dev
