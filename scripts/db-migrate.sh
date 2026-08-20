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

docker compose --env-file .env -f infra/compose.yml up -d postgres

until docker compose --env-file .env -f infra/compose.yml exec -T postgres \
  pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_USER" >/dev/null 2>&1; do
  sleep 1
done

for migration in infra/postgres/migrations/*.sql; do
  echo "Applying $migration"
  docker compose --env-file .env -f infra/compose.yml exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_USER" < "$migration"
done
