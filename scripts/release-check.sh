#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

bash scripts/verify-release-tree.sh
pnpm audit:prod
pnpm typecheck
pnpm test
pnpm build

echo "BranchHarbor release checks passed."
