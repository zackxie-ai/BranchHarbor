#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

set -a
source .env
set +a

api="http://127.0.0.1:${GITEA_HTTP_PORT}/api/v1"
repository_name="cloudagent"
response_file="$(mktemp)"
trap 'rm "$response_file"' EXIT

http_status=$(curl -sS -o "$response_file" -w '%{http_code}' \
  -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASSWORD}" \
  "$api/repos/${GITEA_ADMIN_USER}/${repository_name}")

if [[ "$http_status" == "404" ]]; then
  curl -fsS \
    -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASSWORD}" \
    -H 'Content-Type: application/json' \
    -d '{"name":"cloudagent","description":"CloudAgent control plane and integration workspace","private":true,"auto_init":false,"default_branch":"main"}' \
    "$api/user/repos" >"$response_file"
  echo "Created Gitea repository ${GITEA_ADMIN_USER}/${repository_name}"
elif [[ "$http_status" != "200" ]]; then
  cat "$response_file" >&2
  exit 1
fi

repository_url="http://127.0.0.1:${GITEA_HTTP_PORT}/${GITEA_ADMIN_USER}/${repository_name}.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$repository_url"
else
  git remote add origin "$repository_url"
fi

echo "Gitea origin: $repository_url"
