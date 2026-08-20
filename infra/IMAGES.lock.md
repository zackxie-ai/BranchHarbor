# Runtime image lock

Validated on 2026-08-19 on Apple Silicon Docker Desktop.

| Service | Image | Validated digest |
|---|---|---|
| PostgreSQL | `postgres:17.11-alpine` | `sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73` |
| Gitea | `gitea/gitea:1.27.2-rootless` | `sha256:c7953964c6e8fe532cf7fc3f3efdea1d0b161d7859c47e04f5e05489d494dea0` |
| Temporal | `temporalio/auto-setup:1.29.3` | `sha256:9be7b8d98f60d00f4f2ff74731c071a17848d8182bbc8429e314a24c94ea105b` |
| OpenBao | `openbao/openbao:2.6.2` | `sha256:11fd73a2102cda9c55d5d881a8c3210303146a7ec1e8ac76f526e175c6d24641` |
| AIO Sandbox | `ghcr.io/agent-infra/sandbox:1.11.0` | `sha256:6328d7fd2f0ff0b4c147c3d05b3df1ce331f4a482eb6e550ecd64ed1fcf906e7` |

The digests document the exact tested artifacts. Compose uses readable immutable release tags; production deployment should pin the same images by digest.
