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

smoke_tests=(
  test:membership-invitation
  test:project-membership
  test:audit-query
  test:task-coordination
  test:task-dependency-management
  test:merge-planning
  test:integration-queue
  test:task-workspace-progress
  test:acp
  test:credential-lifecycle
  test:credential-lease-runtime
  test:openai-compatible-agent
  test:integration-agent
  test:merge-plan-agent
  test:project-validation
  test:task-cancellation
  test:task-preview
  test:task-progress-monitor
  test:task-workspace-durability
  test:http-user-flow
)

for smoke_test in "${smoke_tests[@]}"; do
  printf '\n===== %s =====\n' "$smoke_test"
  pnpm "$smoke_test"
done

printf '\nBranchHarbor smoke suite passed (%s probes).\n' "${#smoke_tests[@]}"
