# BranchHarbor foundation

## Product boundary

BranchHarbor owns the product-specific control plane:

- organizations, users, roles, and projects;
- one canonical Git repository per project;
- task branches and isolated worktrees;
- per-user Agent and credential selection;
- Agent sessions, events, permissions, and previews;
- structured and platform-verified change requests;
- Admin review, integration-agent conflict resolution, and two-stage approval;
- verification, audit, usage, and delivery records.

Infrastructure below this boundary remains an internal implementation detail and is only kept when it participates in the current runtime.

## Runtime dependencies

| Capability | Foundation |
|---|---|
| Control-plane data and audit history | PostgreSQL |
| Default Git hosting and protected branches | Gitea |
| Durable tasks, monitoring, and integration workflows | Temporal |
| Credential storage | OpenBao |
| Vendor-neutral Agent protocol | ACP SDK |
| Isolated execution and browser editor | AIO Sandbox image |

BranchHarbor itself implements the Web/API, Worker, task and Worktree lifecycle, Agent Gateway, live events, review UI, preview proxy, merge planning, and integration governance.

## Service boundaries

```text
BranchHarbor Web/API
├── PostgreSQL
├── Gitea
├── Temporal
├── OpenBao
└── BranchHarbor Worker
    └── on-demand AIO Sandbox Runner
        └── Agent process or model API adapter
```

The default deployment does not include a separate cache, object store, multiplayer workspace, or workflow UI. Those capabilities can be added later behind provider interfaces when production scale requires them.

## Local endpoints

| Service | Endpoint |
|---|---|
| BranchHarbor | `http://localhost:3210` |
| Gitea | `http://localhost:3100` |
| OpenBao | `http://localhost:8200` |
| PostgreSQL | `localhost:5432` |

The OpenBao configuration in local Compose uses development mode. Production must use persistent storage, TLS, audit logging, unseal management, and a non-root application policy.
