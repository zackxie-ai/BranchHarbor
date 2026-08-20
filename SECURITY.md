# Security policy

## Supported versions

CloudAgent is alpha software. Security fixes are provided only for the latest commit on `main` and the latest tagged `0.1.x-alpha` release.

| Version | Supported |
|---|---|
| Latest `main` / latest alpha | Yes |
| Older snapshots | No |

## Report a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's **Report a vulnerability** / private security advisory feature for this repository. Include:

- affected version or Commit;
- deployment assumptions;
- reproduction steps or a minimal proof of concept;
- expected and observed impact;
- whether any real credential or personal data was exposed.

Never include active API Keys, passwords, session cookies, OpenBao tokens, private repository contents, or customer data. Revoke any credential that may have been exposed before sending a report.

The maintainers will acknowledge reports when practical, validate the issue, and coordinate disclosure after a fix is available. This project is community maintained and does not currently promise a formal response SLA or bug bounty.

## Alpha deployment warning

The default stack is for local development only:

- OpenBao runs in development mode with a root token.
- Fixture accounts use published initial passwords.
- Services use plain HTTP and bind only to loopback by default.
- Agent and model output can trigger arbitrary shell commands inside Runner containers.
- The control plane can create and remove Docker containers on the host.
- CSRF hardening, rate limiting, MFA, production secret policies, network egress control, and disaster recovery are incomplete.

Do not expose the default stack to an untrusted network. Do not use it to process untrusted repositories or credentials that you cannot immediately revoke.

## Security design

The current trust boundaries, implemented controls, known gaps, and production requirements are documented in [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).
