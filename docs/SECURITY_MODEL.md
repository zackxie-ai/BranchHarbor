# CloudAgent security model

## Scope

This document describes the `v0.1.0-alpha` local architecture. It is not a production security certification.

## Trust boundaries

CloudAgent has five relevant trust zones:

1. **Browser and user account**: submits tasks, prompts, credentials, and approvals.
2. **Control plane and Worker**: enforce authorization, issue leases, orchestrate workflows, and access Docker.
3. **PostgreSQL, Gitea, Temporal, and OpenBao**: persist control state, code, workflows, and secrets.
4. **Task and integration Runners**: execute repository code and model-requested commands.
5. **External model providers**: receive prompts, repository excerpts exposed through tool results, and the user's provider credential.

## Protected assets

- model and Agent API Keys;
- authentication sessions and password hashes;
- private repository contents and Git history;
- Admin approval authority;
- audit history and verification evidence;
- host Docker access and infrastructure credentials.

## Implemented controls

- API Keys are stored in OpenBao; PostgreSQL stores references and lifecycle metadata.
- Each Agent execution receives a version-bound, expiring credential lease.
- Key rotation or revocation invalidates active leases and requests session cancellation.
- Project membership and Admin/member authorization are enforced in server services and routes.
- Tasks use separate Git branches, Worktrees, and Runner containers.
- Ordinary task Agents cannot update the canonical `main` branch through the product workflow.
- Integration occurs in a temporary Worktree and requires two Admin approval stages.
- Git changed files, Commit ancestry, unresolved conflicts, and verification output are platform checked.
- Runner API credentials are generated per Runner and deleted on destruction.
- Local infrastructure ports bind to `127.0.0.1` by default.
- Sensitive local paths and generated state are excluded and checked before release.

## Untrusted inputs

Treat all of the following as hostile or fallible:

- user prompts and repository content;
- Agent messages and tool arguments;
- external model responses;
- test and build output;
- application previews;
- user-configured OpenAI-compatible API endpoints.

An Agent's statement that work is complete is not evidence. CloudAgent must continue to calculate Git and verification facts independently.

## Known alpha gaps

- Runner containers are process-isolation boundaries, not hardened hostile-code sandboxes.
- Model API egress and task network access are not restricted by per-project allowlists.
- User-configured model endpoints require stronger SSRF controls for hostile multi-tenant use.
- OpenBao uses development mode, a root token, HTTP, and ephemeral storage.
- CSRF protection beyond SameSite cookies, request rate limiting, MFA, and device session management are incomplete.
- Preview proxy support is intended for local HTTP development, not hostile public applications.
- Docker control remains a high-value host capability.
- Backups, restore drills, production observability, and incident response automation are incomplete.

## Production requirements

Before any internet-facing or multi-tenant deployment:

- replace OpenBao development mode with TLS, persistent storage, unseal management, audit logging, and least-privilege policies;
- replace all fixture and infrastructure credentials;
- deploy behind HTTPS with CSRF defenses, rate limiting, MFA, and secure cookie settings;
- isolate control-plane, data, and Runner networks;
- restrict Runner and model-provider egress;
- enforce SSRF-safe provider endpoint policies;
- harden container profiles, capabilities, filesystem mounts, and resource limits;
- protect Docker access with a dedicated scheduler boundary;
- implement encrypted backups and tested recovery for PostgreSQL, Gitea, OpenBao, and Temporal;
- add centralized logs, metrics, alerting, and incident procedures;
- complete an independent security review.
