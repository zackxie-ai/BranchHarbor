# BranchHarbor Implementation Status

> Updated: 2026-08-20
> Release: `v0.1.0-alpha.0`
> Deployment scope: local development and evaluation

## End-to-end workflow

The current implementation supports this complete local workflow:

```text
Create project and private Gitea repository
  -> add project members
  -> create scoped tasks and dependencies
  -> provision isolated task branches, Worktrees, and Runners
  -> run member-owned ACP, Codex, or model API Agents
  -> persist task branches and WIP checkpoints remotely
  -> inspect Git progress, drift, overlap, logs, tests, and previews
  -> submit a structured change request from a clean Commit
  -> Admin review and first approval
  -> dependency-aware Integration Queue
  -> temporary Integration Worktree and Runner
  -> Git merge or Admin-owned Integration Agent conflict resolution
  -> integration verification and second Admin approval
  -> fast-forward protected main
  -> project-level validation on the latest main
```

## Implemented capabilities

### Identity and authorization

- Email/password authentication with `scrypt` password hashing.
- HttpOnly, SameSite=Lax sessions stored as token hashes.
- Failed-login lockout and mandatory first-login password change.
- One-time membership invitations stored as token hashes.
- Organization Admin/member roles and explicit project membership.
- Service- and API-level authorization across all protected resources.

### Projects, Git, and collaboration

- One private Gitea repository and protected `main` per project.
- One branch, Worktree, Runner, and Agent session per task.
- Immediate remote task-branch creation and remote WIP checkpoints.
- Platform-calculated Commit, Diff, rename, ancestry, and cleanliness evidence.
- Explicit dependencies with cycle, project, state, failure, and recovery validation.
- Background Git monitoring, main drift, overlap, structural conflict warnings, snapshots, and per-user notifications.
- Automatic Worktree reconstruction after local directory loss.

### Agents and credentials

- Codex JSONL, ACP stdio, and OpenAI-compatible Chat Completions connections.
- Hosted `run_shell` tool loop for DeepSeek and compatible model APIs.
- Member-owned Agent connections and OpenBao credentials.
- Credential versioning, rotation, revocation, access events, and short-lived leases.
- Automatic session termination on lease expiry, rotation, or revocation.
- Persistent sessions, events, permission requests, cancellation, and continuation.

### Runners, previews, review, and integration

- Task, integration, merge-planning, and project-validation Docker Runners.
- Authenticated application preview proxy with assets, logs, stop, restart, and history.
- Structured change requests with authoritative Git and verification evidence.
- Admin request-changes, reject, approve-integration, and approve-final decisions.
- Deterministic merge planning and read-only semantic Agent recommendations.
- Atomic Integration Queues with ordering and bypass prevention.
- Temporary Integration Worktrees and optional Admin-owned conflict-resolution Agents.
- Verification before final approval and protected `main` update.
- Cross-task project validation tied to completed queues.

### Audit and workflow durability

- Organization-scoped audit records with actor and structured evidence.
- Admin-only audit filtering by event, user, project, task, date, and payload text.
- Temporal workflows with deterministic IDs, retries, heartbeats, and persistent history.
- Background monitoring that survives parent workflow completion and Worker restarts.

## API surface

The control plane provides authenticated routes for audit, projects, members, tasks, dependencies, notifications, merge plans, integration queues, validations, Worktrees, Runners, previews, Agent credentials and sessions, change requests, reviews, integrations, and finalization. See `apps/control-plane/src/app/api` for route definitions.

## Verification matrix

### Fast suite

```bash
pnpm typecheck
pnpm test
pnpm build
```

The unit suite contains 58 tests across authentication, validation, Git, conflicts, merge planning, queues, previews, and Temporal workflows.

### Full smoke suite

```bash
pnpm test:smoke
```

The 20 sequential probes exercise real PostgreSQL, OpenBao, Temporal, Git, Gitea, Docker Runners, authenticated HTTP pages, and local mock Agents. They cover invitations, project isolation, dependencies, Git progress, conflict detection, checkpoints, recovery, ACP sessions, credentials, leases, model API tool calls, Integration Agents, merge planning, queues, project validation, cancellation, previews, monitoring, cleanup, and authenticated page/API behavior.

Mock model services are used; automated tests do not consume external model credits.

## Open-source release readiness

- MIT License and complete community, support, security, and release documentation.
- GitHub CI on Node.js 20 and 22, CodeQL, Dependabot, and contribution templates.
- `pnpm release:tree` blocks local configuration, credentials, runtime state, generated output, common secret formats, machine-specific paths, and non-English release text.
- `pnpm release:check` runs release-tree validation, production dependency audit, type checking, unit tests, and production build.
- A clean release-candidate copy installs and builds from the lockfile.

## Known Alpha limitations

- The default stack uses fixture accounts, plain HTTP, and OpenBao development mode.
- Default Runner networking is not hardened for untrusted multi-tenant workloads.
- Provider API Keys remain long-lived unless the provider supports short-lived tokens.
- Email delivery, password reset, MFA, device session management, CSRF hardening, and rate limiting are incomplete.
- The preview proxy does not support every WebSocket/HMR or absolute-root asset pattern.
- Structural analysis does not understand every language, database, or business semantic conflict.
- Every third-party Agent version is not guaranteed compatible.
- Production backup, TLS, network policy, quotas, observability, upgrade, and disaster-recovery procedures remain operator responsibilities.

Do not expose the default stack to the public internet or use it as a hardened multi-tenant service.
