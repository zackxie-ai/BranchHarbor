# CloudAgent Product Vision

> Status: active product direction
> Last confirmed: 2026-08-20

## Definition

CloudAgent is a multi-user cloud development control plane for AI-assisted software teams. Each task runs in an isolated Git Worktree and Runner. Every member brings their own coding Agent or model API and credentials. The platform shares verified progress and gives an Admin controlled, two-stage integration authority over the canonical project.

## Non-negotiable outcomes

CloudAgent must support:

1. multiple authenticated team members;
2. browser access from separate computers;
3. member-selected Agents and model providers;
4. credentials owned and controlled by each member;
5. one canonical protected Git repository per project;
6. independent branches, Worktrees, Runners, and Agent sessions per task;
7. shared progress based on real Git and verification evidence;
8. no ordinary member or Agent writes to `main`;
9. Admin review of every proposed change;
10. optional AI-assisted integration using the Admin's Agent and credentials;
11. separate integration and final approvals;
12. durable audit evidence for permissions, credentials, Git state, and merges.

An architecture that only lets multiple Agents chat, but lacks user isolation, task Worktrees, BYOK, verified progress, and controlled integration, does not satisfy the CloudAgent vision.

## Product model

```text
CloudAgent project
|-- main                         protected accepted state
|-- task/<id>-<slug>             member task branch
|   |-- dedicated Worktree
|   |-- dedicated Runner
|   `-- member-owned Agent session
`-- integration/<change-id>      temporary Admin integration branch
    |-- dedicated Worktree
    |-- dedicated Runner
    `-- optional Admin-owned Agent session
```

## Evidence model

Agent prose is useful context but never authoritative. CloudAgent independently records or verifies branch and Commit identities, changed files, rename history, Diff statistics, ancestry, Worktree cleanliness, checkpoints, command output, exit codes, Runner lifecycle, credential leases, approvals, integration order, and final `main` updates.

## Collaboration model

The project page should let a team understand work without opening every environment: intended and actual changes, ownership, assigned Agent, dependencies, Git progress, main drift, overlap, verification, previews, review state, and integration readiness.

CloudAgent uses soft coordination and explicit dependencies rather than pretending that static path locks can understand every semantic conflict.

## Integration model

The Admin receives a deterministic dependency-aware ordering and may request an Agent-generated semantic recommendation. Recommendations remain advisory. Integration runs in a temporary environment, and the accepted project changes only after:

1. the change request is approved for integration;
2. Git merge or conflict resolution completes;
3. the integration result contains the task Commit;
4. verification passes;
5. the Admin grants final approval.

## Credential model

- Members configure only their own Agent or model credentials.
- PostgreSQL stores references and lifecycle metadata, not plaintext keys.
- OpenBao stores the secret value.
- Each execution receives a version-bound, expiring lease.
- Rotation or revocation invalidates active leases and stops affected sessions.
- The Admin cannot silently replace another member's key.

## Current delivery boundary

The current release is a functional local Alpha. It demonstrates the full control-plane workflow on one trusted host. It is not yet a hardened public multi-tenant service. Production deployment requires stronger identity controls, network isolation, secret policies, backups, observability, quotas, TLS, and disaster recovery.

## Success criteria

CloudAgent succeeds when a team can independently develop multiple tasks with different Agents and providers, understand real progress from one place, detect integration risk early, and merge approved work into one project without giving task Agents direct control of `main`.
