# Contributing to CloudAgent

CloudAgent welcomes focused bug fixes, tests, documentation, provider adapters, and improvements to Git or workflow safety.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).

## Before starting

- Read [README.md](README.md), [SECURITY.md](SECURITY.md), and [docs/PRODUCT_VISION.md](docs/PRODUCT_VISION.md).
- Search existing issues before opening a duplicate.
- Discuss large architecture changes before implementing them.
- Report security issues privately, never in a public issue.

## Local setup

Requirements are listed in the README.

```bash
corepack enable
pnpm install --frozen-lockfile
make bootstrap
make dev
```

Local state belongs in `.env`, `infra/data/`, and `runtime/`. These paths must never be committed.

## Development rules

- Keep Agent output untrusted. Platform-calculated Git and verification evidence remains authoritative.
- Preserve task Worktree isolation and the rule that ordinary Agents cannot write `main`.
- Never log, persist, or return plaintext model credentials.
- Enforce authorization in services and APIs, not only in UI components.
- Add a new numbered SQL migration instead of editing a migration that may already have run.
- Avoid unrelated refactors in behavior or security changes.
- Do not add a dependency when a small standard-library implementation is sufficient.

## Tests

Run the fast suite for every pull request:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Run the relevant Docker-backed smoke test when changing Git, Runner, credential, Agent, Temporal, preview, or integration behavior. The available commands are listed in `package.json` and [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

Before proposing a release:

```bash
pnpm release:check
```

Tests must not consume a contributor's external model credits. Use a local mock API unless a live provider test is explicitly opt-in.

## Pull requests

A pull request should:

- explain the problem and the chosen behavior;
- identify security or migration impact;
- include focused tests;
- list manual or smoke-test evidence;
- update documentation when user-visible behavior changes;
- avoid generated output and local configuration.

Use clear, imperative Commit subjects. Keep the pull request small enough to review as one coherent change.
