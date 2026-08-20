# Changelog

All notable changes to CloudAgent are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

No unreleased changes.

## [0.1.0-alpha.0] - 2026-08-20

### Added

- Multi-user CloudAgent control plane with Admin/member authorization.
- Gitea project repositories, protected `main`, task branches, and isolated Worktrees.
- Docker Runner lifecycle, application previews, and Temporal workflows.
- Codex JSONL, ACP stdio, and OpenAI-compatible model API Agent connections.
- Hosted coding-agent tool loop for DeepSeek and compatible APIs.
- OpenBao BYOK storage, credential lifecycle, short-lived execution leases, and audit events.
- Change requests, dependency coordination, integration queues, validation, and two-stage merge approval.
- Remote task branch and WIP checkpoint durability with workspace recovery.
- English-only web UI, runtime messages, documentation, and release-tree enforcement.
- Open-source release governance, security documentation, CI, and release checks.
- Structured `400 VALIDATION_ERROR` responses for invalid API payloads.
- A preserved default of 24 tool rounds when lower-level Agent connection callers omit the optional value.
- Authenticated HTTP user-flow coverage for project, membership, task, page, and API behavior.
- A 20-probe Docker, Temporal, Git, credential, Agent, workflow, and HTTP smoke suite.
- Task coordination smoke coverage using a real remote repository and isolated task Worktrees.
