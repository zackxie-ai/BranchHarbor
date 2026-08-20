# Agent contribution guide

- Read `README.md`, `CONTRIBUTING.md`, and `SECURITY.md` before changing behavior.
- Use `pnpm` with the version declared in `package.json`.
- Keep changes scoped and preserve the Git Worktree, credential, and Admin approval boundaries.
- Never commit `.env`, `runtime/`, `infra/data/`, model credentials, or local MCP configuration.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before submitting changes.
- Add focused tests for authorization, credential handling, Git state, or workflow transitions.
- Treat Agent output as untrusted; platform-calculated Git and verification evidence is authoritative.
