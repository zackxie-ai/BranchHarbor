# Foundation setup status

Validated on 2026-08-20.

## Runtime services

- PostgreSQL stores BranchHarbor, Gitea, audit, and workflow metadata.
- Gitea provides the default private Git repository and protected `main` branch.
- Temporal runs durable BranchHarbor workflows; its standalone debugging UI is not part of the default deployment.
- OpenBao stores user, Admin, and Runner credentials.
- AIO Sandbox is started on demand for isolated task and integration Runners.
- The BranchHarbor Next.js control plane and Temporal Worker are BranchHarbor-owned processes.

## Removed defaults

- Clay was removed because BranchHarbor now owns Agent sessions, events, permissions, and collaboration UI.
- Valkey was removed because no core runtime path used it.
- MinIO was removed because artifacts and snapshots do not yet require an object store.
- Temporal UI was removed because it was only a development debugging surface.
- Independent upstream source checkouts were removed because runtime dependencies come from versioned packages and container images.

The remaining runtime is the smallest set that supports the current verified Git, BYOK, Runner, durable workflow, review, and two-stage integration flow.
