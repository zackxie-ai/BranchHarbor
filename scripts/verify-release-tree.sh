#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

required_files=(
  LICENSE
  README.md
  SECURITY.md
  CONTRIBUTING.md
  CODE_OF_CONDUCT.md
  CHANGELOG.md
  THIRD_PARTY_NOTICES.md
  .github/workflows/ci.yml
)

for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Missing release file: $required_file" >&2
    exit 1
  fi
done

blocked_files=(
  .env
  .mcp.json
  apps/control-plane/tsconfig.tsbuildinfo
)

blocked_directories=(
  runtime
  infra/data
  .concord
  .codex
  .cursor
  apps/control-plane/.next
)

for blocked_file in "${blocked_files[@]}"; do
  if ! git check-ignore --no-index -q "$blocked_file"; then
    echo "Release-sensitive file is not ignored: $blocked_file" >&2
    exit 1
  fi
done

for blocked_directory in "${blocked_directories[@]}"; do
  if ! git check-ignore --no-index -q "$blocked_directory/.branchharbor-ignore-check"; then
    echo "Release-sensitive directory is not ignored: $blocked_directory" >&2
    exit 1
  fi
done

candidate_files="$(mktemp)"
trap 'rm -f "$candidate_files"' EXIT
while IFS= read -r candidate_file; do
  if [[ -f "$candidate_file" ]]; then
    printf '%s\n' "$candidate_file" >> "$candidate_files"
  fi
done < <(git ls-files --cached --others --exclude-standard)

if grep -E '(^|/)(\.env|runtime|infra/data|\.next|node_modules|\.concord|\.codex|\.cursor)(/|$)|(^|/)\.mcp\.json$|\.tsbuildinfo$' "$candidate_files"; then
  echo "Generated, private, or local-only files entered the release tree." >&2
  exit 1
fi

if xargs -r rg -n \
  -e '(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}' \
  -e 'ghp_[A-Za-z0-9]{20,}' \
  -e 'github''_pat_' \
  -e 'BEGIN [A-Z ]*PRIVATE KEY' \
  < "$candidate_files"; then
  echo "A possible secret was found in the release tree." >&2
  exit 1
fi

if xargs -r rg -n '/''Users/[^/]+/' < "$candidate_files"; then
  echo "A local macOS home path was found in the release tree." >&2
  exit 1
fi

if xargs -r rg -n '[\p{Han}\p{Hiragana}\p{Katakana}\p{Hangul}]' < "$candidate_files"; then
  echo "Non-English CJK text was found in the release tree." >&2
  exit 1
fi

brand_candidate_files="$(mktemp)"
trap 'rm -f "$candidate_files" "$brand_candidate_files"' EXIT
grep -v '^infra/postgres/migrations/001_control_plane.sql$' "$candidate_files" > "$brand_candidate_files"

if xargs -r rg -n -i 'cloud''agent' < "$brand_candidate_files"; then
  echo "A legacy product identifier was found outside the historical bootstrap migration." >&2
  exit 1
fi

echo "Release tree checks passed ($(wc -l < "$candidate_files" | tr -d ' ') files)."
