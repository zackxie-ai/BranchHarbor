# BranchHarbor Project Goal

## One-sentence goal

BranchHarbor is a cloud collaboration control plane where multiple developers use their own computers, coding agents, model providers, and credentials to work in parallel on one protected Git project, while an Admin reviews and integrates every result.

## Problem

AI-assisted development is still usually organized around one person, one computer, and one local checkout. That model breaks down for teams:

- local work and Agent sessions are difficult to observe;
- multiple Agents can overwrite the same files;
- each developer may use a different Agent, provider, API Key, or subscription;
- Agent summaries are not authoritative evidence of code changes;
- task dependencies and semantic conflicts complicate integration;
- allowing members or Agents to write directly to `main` creates unacceptable risk.

BranchHarbor turns these disconnected activities into an isolated, observable, reviewable, and auditable workflow.

## Core operating model

### One canonical Git project

- Every BranchHarbor project owns one canonical Git repository.
- `main` represents the accepted project state and remains protected.
- Ordinary members and task Agents cannot write directly to `main`.
- Code, terminals, tests, and previews execute in managed environments.

### One isolated workspace per task

Each task receives its own:

- Git branch and Worktree;
- sandbox Runner;
- Agent session;
- terminal, logs, verification output, and application preview.

Tasks can run concurrently without sharing a writable checkout.

### Bring your own Agent and credentials

Members may use supported ACP or Codex adapters, or connect an OpenAI-compatible model API. BranchHarbor can host the coding tool loop when the user provides only a model API.

Credentials remain isolated by owner. They are stored in OpenBao, injected only into the assigned Runner under a short-lived lease, and revoked when the execution ends, expires, or is cancelled.

### Share verified progress

The team can inspect projects, members, tasks, dependencies, Agent events, changed files, Commits, Diffs, Worktree snapshots, verification output, previews, drift, conflict warnings, reviews, queues, and project validation.

Shared progress means shared visibility into isolated workspaces, not shared write access to one directory.

## Roles

### Member

A member works in an assigned task Worktree with their own Agent and credentials. They can develop, test, preview, Commit, and submit a structured change request. They cannot access another member's credentials, bypass project membership, merge their own work, or write to protected `main`.

### Admin

An Admin manages members and task coordination, reviews Git and verification evidence, requests changes or rejects work, selects integration order, optionally uses an Admin-owned Integration Agent to resolve conflicts, and grants the final approval required to update `main`.

## Standard workflow

1. A member or Admin creates a scoped task with acceptance criteria and verification commands.
2. BranchHarbor provisions a task branch, Worktree, Runner, and Agent session.
3. The member develops with their own Agent and provider credentials.
4. BranchHarbor records Agent events, Git progress, verification, previews, and risks.
5. The member creates a Commit and submits a structured change request.
6. The Admin reviews authoritative evidence and approves, rejects, or requests changes.
7. BranchHarbor creates a temporary Integration Worktree and Runner.
8. Git or the Admin's Integration Agent merges the approved task.
9. BranchHarbor reruns verification and records the integration result.
10. The Admin grants final approval.
11. Only then may BranchHarbor update protected `main`.

## Product invariants

1. Isolation comes first.
2. Git and platform verification are the source of truth.
3. Ordinary task execution cannot write `main`.
4. Integration approval and final approval are separate decisions.
5. AI can recommend and execute, but the Admin remains accountable.
6. Security-sensitive actions and credential use are auditable.
7. The platform remains Agent- and provider-neutral.
8. The product is designed for real development workflows, not only demonstrations.
