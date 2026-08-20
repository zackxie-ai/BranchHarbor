# BranchHarbor original product scope

The reusable foundation is installed. The following capabilities are the BranchHarbor-specific work that still must be designed and implemented.

## 1. Control plane

- organizations, memberships, roles, and invitations;
- BranchHarbor projects backed by one canonical Gitea repository;
- user-to-agent and user-to-credential bindings;
- project policy, audit trail, quotas, and usage accounting.

## 2. Task workspaces

- create a task branch and worktree from a selected base commit;
- assign the worktree to one user and one selected agent;
- start, pause, resume, expire, and destroy the isolated runner;
- expose terminal, code-server, logs, preview, and Agent events in one task page.

## 3. Change submissions

- require commits before a task is submitted;
- generate a human-readable Agent summary;
- calculate authoritative Git facts: base/head commit, diff, changed files, and conflict risk;
- execute verification commands and store their real results;
- create an immutable change request for Admin review.

## 4. Admin review

- show summaries, diffs, tests, previews, Agent sessions, and risks;
- support request-changes, reject, approve-for-integration, and cancellation;
- protect `main` from direct user and Agent writes;
- record every approval decision and actor.

## 5. Integration Agent

- create a temporary integration branch and runner;
- attempt a normal Git merge before invoking AI;
- inject only the Admin-selected Agent credentials;
- resolve conflicts without writing directly to `main`;
- run verification and generate a merge report;
- wait for a second Admin approval before updating `main`.

## 6. Production hardening

- replace OpenBao development mode with persistent TLS-backed deployment;
- provision one sandbox or microVM per task instead of one shared local sandbox;
- add runner network policies, CPU/memory quotas, timeouts, and credential revocation;
- implement PostgreSQL migrations, backups, observability, and disaster recovery;
- add production authentication, CSRF protection, rate limiting, and tenant isolation.

These are the parts that make the product BranchHarbor rather than a repackaging of its Git, workflow, secret-storage, or runner infrastructure.
