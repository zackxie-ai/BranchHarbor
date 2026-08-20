# Third-party notices

CloudAgent source code is licensed under MIT. Dependencies and container images are separate works and retain their own licenses.

The repository does not vendor `node_modules` or container image files. Exact JavaScript dependency versions are recorded in `pnpm-lock.yaml`; exact validated container versions and digests are recorded in `infra/IMAGES.lock.md`.

Direct runtime dependencies include:

| Component | Purpose | License |
|---|---|---|
| Next.js | Web framework | MIT |
| React / React DOM | UI runtime | MIT |
| PostgreSQL client (`pg`) | Database access | MIT |
| Zod | Input validation | MIT |
| Temporal TypeScript SDK | Durable workflows | MIT |
| Agent Client Protocol SDK | Agent transport | Apache-2.0 |

The production dependency graph also includes compatible Apache-2.0, BSD, ISC, MIT, Unlicense, 0BSD, CC-BY-4.0, and dynamically linked LGPL components. In particular, Sharp distributions can include libvips under LGPL terms. `unionfs` 4.6.0 includes an Unlicense text even though its package metadata does not declare a license field.

Generate the dependency inventory from the lockfile with:

```bash
pnpm licenses list --prod
```

Container images used by the local stack include PostgreSQL, Gitea, Temporal, OpenBao, and AIO Sandbox. Review each image's upstream license and notices before redistributing an image or a bundled appliance. CloudAgent's MIT license does not replace those terms.
