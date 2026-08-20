# Release checklist

## Repository

- [ ] Release tree check passes.
- [ ] No `.env`, credentials, runtime data, build output, or local Agent configuration is included.
- [ ] Version and changelog are updated.
- [ ] License and third-party notices are present.
- [ ] Documentation contains no machine-specific paths.

## Verification

- [ ] `pnpm audit:prod` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm build` passes.
- [ ] Relevant Docker-backed smoke tests pass.
- [ ] A clean release-tree copy installs and builds.

## Security

- [ ] Security model and known gaps match the release.
- [ ] Default deployment is still clearly marked local-only when production controls are incomplete.
- [ ] No live provider credentials were used by automated tests.
- [ ] New endpoints have authorization and input validation tests.

## Publication

- [ ] CI is green on the release Commit.
- [ ] Tag uses Semantic Versioning, for example `v0.1.0-alpha.0`.
- [ ] Release notes describe breaking changes and known limitations.
- [ ] Published artifacts match the tagged Commit.
