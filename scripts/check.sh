#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo ".env is missing; run make bootstrap first." >&2
  exit 1
fi

set -a
source .env
set +a

failures=0

check_http() {
  local name="$1"
  local url="$2"
  if curl -fsS "$url" >/dev/null 2>&1; then
    printf 'OK   %-12s %s\n' "$name" "$url"
  else
    printf 'FAIL %-12s %s\n' "$name" "$url"
    failures=$((failures + 1))
  fi
}

check_tcp() {
  local name="$1"
  local port="$2"
  if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
    printf 'OK   %-12s localhost:%s\n' "$name" "$port"
  else
    printf 'FAIL %-12s localhost:%s\n' "$name" "$port"
    failures=$((failures + 1))
  fi
}

check_http Gitea "http://127.0.0.1:${GITEA_HTTP_PORT}/api/healthz"
if docker compose --env-file .env -f infra/compose.yml exec -T temporal \
  tctl --address temporal:7233 cluster health >/dev/null 2>&1; then
  printf 'OK   %-12s %s\n' Temporal "localhost:${TEMPORAL_GRPC_PORT:-7233}"
else
  printf 'FAIL %-12s %s\n' Temporal "localhost:${TEMPORAL_GRPC_PORT:-7233}"
  failures=$((failures + 1))
fi
if docker compose --env-file .env -f infra/compose.yml exec -T temporal \
  tctl --address temporal:7233 taskqueue describe \
  --taskqueue "${TEMPORAL_TASK_QUEUE:-branchharbor-control-plane}" 2>/dev/null | grep -Eq '[0-9]+@'; then
  printf 'OK   %-12s %s\n' TemporalWorker "${TEMPORAL_TASK_QUEUE:-branchharbor-control-plane}"
else
  printf 'FAIL %-12s %s\n' TemporalWorker "${TEMPORAL_TASK_QUEUE:-branchharbor-control-plane}"
  failures=$((failures + 1))
fi
check_http OpenBao "http://127.0.0.1:${OPENBAO_PORT}/v1/sys/health"
check_tcp PostgreSQL "${POSTGRES_PORT}"

if nc -z 127.0.0.1 "${CONTROL_PLANE_PORT:-3210}" >/dev/null 2>&1; then
  check_http BranchHarbor "http://127.0.0.1:${CONTROL_PLANE_PORT:-3210}/api/health"
else
  printf 'SKIP %-12s control plane is stopped\n' BranchHarbor
fi

exit "$failures"
