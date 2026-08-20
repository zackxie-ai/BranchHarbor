import Link from "next/link";

import {
  configureAgentCredentialAction,
  createProjectAction,
  revokeAgentCredentialAction,
} from "./actions";
import { AgentConnectionForm } from "@/components/agent-connection-form";
import { requirePageUser } from "@/lib/auth";
import {
  listAgentConnections,
  listAgentCredentialLeases,
  listProjects,
  listUsers,
} from "@/lib/repositories";
import type { AgentCredentialLease } from "@/lib/types";

export const dynamic = "force-dynamic";

function formatLifecycleDate(value: Date | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(value);
}

function credentialLeaseLabel(status: AgentCredentialLease["status"]): string {
  if (status === "active") return "active";
  if (status === "expired") return "expired";
  if (status === "revoked") return "revoked";
  return "released";
}

export default async function HomePage() {
  const actor = await requirePageUser();
  const [projects, agents, users, credentialLeases] = await Promise.all([
    listProjects(actor.id),
    listAgentConnections(actor.organizationId),
    listUsers(actor.organizationId),
    listAgentCredentialLeases(actor.id),
  ]);
  const userNames = new Map(users.map((user) => [user.id, user.name]));

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Multiple people · Multiple Agents · Isolated Worktrees</span>
          <h1>Run the team's AI-assisted development from one control plane.</h1>
          <p>
            Each member develops in an isolated branch with their own Agent and credentials. BranchHarbor
            records tasks, code, verification, and approvals, while the Admin decides what enters the canonical project.
          </p>
        </div>
        <div className="panel workflow">
          {[
            "Create one canonical cloud Git project",
            "Provision an isolated Worktree per task",
            "Develop with member-owned Agents",
            "Submit a verifiable change request",
            "Complete two-stage Admin approval",
          ].map((step, index) => (
            <div className="workflow-step" key={step}>
              <span>{index + 1}</span>
              {step}
            </div>
          ))}
        </div>
      </section>

      <section className="section-head">
        <div>
          <h2>Cloud projects</h2>
          <p>Each project maps to a Gitea repository managed by BranchHarbor.</p>
        </div>
      </section>

      {projects.length > 0 ? (
        <div className="grid">
          {projects.map((project) => (
            <Link className="card" href={`/projects/${project.id}`} key={project.id}>
              <span className="eyebrow">{project.giteaOwner}/{project.giteaRepository}</span>
              <h3 style={{ marginTop: 10 }}>{project.name}</h3>
              <div className="metric-row">
                <div className="metric">
                  <strong>{project.taskCount ?? 0}</strong>
                  <span>Tasks</span>
                </div>
                <div className="metric">
                  <strong>{project.pendingReviewCount ?? 0}</strong>
                  <span>Pending review</span>
                </div>
              </div>
              <div className="card-meta">
                <span>Default branch {project.defaultBranch}</span>
                <span>Open project →</span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="empty">No projects yet. Create the first BranchHarbor project below.</div>
      )}

      {actor.role === "admin" && (
        <>
          <section className="section-head">
            <div>
              <h2>Create project</h2>
              <p>BranchHarbor creates a private Gitea repository and prepares its control-plane clone.</p>
            </div>
          </section>
          <div className="panel">
            <form className="form" action={createProjectAction}>
              <div className="form-row">
                <label>
                  Project name
                  <input name="name" placeholder="Example: AI collaboration editor" required minLength={2} />
                </label>
                <label>
                  Repository slug (optional)
                  <input name="slug" placeholder="Leave blank to generate one" maxLength={80} />
                </label>
              </div>
              <div className="button-row">
                <button className="button" type="submit">Create cloud project</button>
              </div>
            </form>
          </div>
        </>
      )}

      <section className="section-head" id="agents">
        <div>
          <h2>Member-owned Agents and credentials</h2>
          <p>API Keys are stored in OpenBao. The database and UI retain only credential references and lifecycle state.</p>
        </div>
      </section>
      <div className="grid two">
        {agents.map((agent) => {
          const configure = configureAgentCredentialAction.bind(null, agent.id);
          const revoke = revokeAgentCredentialAction.bind(null, agent.id);
          const isOwner = agent.userId === actor.id;
          const usesModelApi = agent.protocol === "openai-compatible";
          const credentialStatus = agent.credentialConfigured
            ? usesModelApi ? "Model Key configured" : "Agent Key configured"
            : agent.credentialRevokedAt
              ? "Key revoked"
              : "Key required";
          const agentLeases = credentialLeases.filter(
            (lease) => lease.agentConnectionId === agent.id,
          );
          const activeLeaseCount = agentLeases.filter((lease) => lease.status === "active").length;
          const latestLease = agentLeases[0] ?? null;
          const credentialForm = (
            <form className="form" action={configure}>
              <label>
                {usesModelApi ? "Model API Key" : "Agent API Key"}
                <input
                  type="password"
                  name="apiKey"
                  autoComplete="off"
                  required
                  minLength={20}
                  placeholder={usesModelApi ? "Enter a new model provider API Key" : "Enter new Agent service credentials"}
                />
              </label>
              <label>
                {usesModelApi ? "Model" : "Model (optional)"}
                <input
                  name="model"
                  defaultValue={agent.model ?? ""}
                  placeholder={usesModelApi ? "Example: deepseek-chat" : "Use the Agent default model"}
                />
              </label>
              <button className="button secondary" type="submit">
                {agent.credentialConfigured ? "Confirm credential replacement" : "Save credentials"}
              </button>
            </form>
          );
          return (
            <div className="panel" key={agent.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <span className="eyebrow">{userNames.get(agent.userId)}</span>
                  <h3 style={{ marginTop: 8 }}>{agent.displayName}</h3>
                </div>
                <span className={`status ${agent.credentialConfigured ? "status-success" : "status-warning"}`}>
                  {credentialStatus}
                </span>
              </div>
              <p>{agent.provider} · {agent.protocol} · {agent.model ?? "Default model"}</p>
              <p className="muted">
                Credential version: <strong>v{agent.credentialVersion}</strong> · Last rotation: {formatLifecycleDate(agent.credentialRotatedAt)}
              </p>
              <p className="muted">
                Last used: {formatLifecycleDate(agent.credentialLastUsedAt)}
                {agent.credentialRevokedAt ? ` · Revoked: ${formatLifecycleDate(agent.credentialRevokedAt)}` : ""}
              </p>
              {isOwner ? (
                <p className="muted">
                  Short-lived execution leases: <strong>{activeLeaseCount}</strong> active
                  {latestLease
                    ? ` · Latest ${credentialLeaseLabel(latestLease.status)} · Expires ${formatLifecycleDate(latestLease.expiresAt)}`
                    : " · No execution history"}
                </p>
              ) : null}
              {usesModelApi ? (
                <p className="muted">Model endpoint: <code>{agent.apiBaseUrl}</code> · Up to {agent.maxToolRounds} tool rounds</p>
              ) : (
                <p className="muted">
                  Runner command: <code>{agent.launcherCommand ?? "Not configured"}{agent.launcherArguments.length > 0 ? ` ${agent.launcherArguments.join(" ")}` : ""}</code>
                </p>
              )}
              {isOwner && agent.credentialConfigured ? (
                <details>
                  <summary>{usesModelApi ? "Replace model API Key" : "Replace Agent API Key"}</summary>
                  {credentialForm}
                </details>
              ) : isOwner ? (
                credentialForm
              ) : (
                <p className="muted">Only the credential owner can configure or replace the Key for this connection.</p>
              )}
              {isOwner && agent.credentialConfigured ? (
                <form action={revoke}>
                  <button className="button danger" type="submit">Revoke credentials and stop related Agents</button>
                </form>
              ) : null}
            </div>
          );
        })}
      </div>

      <section className="section-head">
        <div>
          <h2>Connect a new Agent</h2>
          <p>A model API is enough. BranchHarbor can host the Agent tool loop that reads code, edits files, runs commands, and creates Git Commits.</p>
        </div>
      </section>
      <div className="panel">
        <AgentConnectionForm />
      </div>
    </>
  );
}
