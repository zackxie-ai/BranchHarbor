import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { deleteSecret, writeSecret } from "../apps/control-plane/src/lib/openbao";
import {
  getAgentConnection,
  getIntegrationRunner,
  insertAgentConnection,
  insertChangeRequest,
  insertProject,
  insertTask,
  listCredentialAccessEvents,
  listIntegrationAgentSessions,
} from "../apps/control-plane/src/lib/repositories";
import { destroyRunner } from "../apps/control-plane/src/lib/runner";
import { runIntegrationAgent, startIntegration } from "../apps/control-plane/src/lib/services";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adminId = "00000000-0000-4000-8000-000000000101";
const projectId = randomUUID();
const connectionId = randomUUID();
const projectRoot = path.join(config.runtimeRoot, "projects", projectId);
const originPath = path.join(projectRoot, "origin.git");
const seedPath = path.join(projectRoot, "seed");
const repositoryPath = path.join(projectRoot, "repository");
const credentialRef = `openbao://secret/agent-connections/${connectionId}`;
const integrationApiKey = "cloudagent-integration-smoke-key";

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function main() {
  let integrationId: string | null = null;
  try {
    await mkdir(projectRoot, { recursive: true });
    await execFileAsync("git", ["init", "--bare", originPath]);
    await execFileAsync("git", ["init", seedPath]);
    await git(seedPath, ["config", "user.name", "CloudAgent Smoke"]);
    await git(seedPath, ["config", "user.email", "smoke@cloudagent.local"]);
    await git(seedPath, ["checkout", "-b", "main"]);
    await execFileAsync("sh", ["-lc", "printf 'base\\n' > conflict.txt"], { cwd: seedPath });
    await git(seedPath, ["add", "conflict.txt"]);
    await git(seedPath, ["commit", "-m", "Base"]);
    const baseCommit = (await git(seedPath, ["rev-parse", "HEAD"])).stdout.trim();
    await git(seedPath, ["remote", "add", "origin", originPath]);
    await git(seedPath, ["push", "-u", "origin", "main"]);
    await execFileAsync("git", ["--git-dir", originPath, "symbolic-ref", "HEAD", "refs/heads/main"]);

    await git(seedPath, ["checkout", "-b", "task/conflict"]);
    await execFileAsync("sh", ["-lc", "printf 'task change\\n' > conflict.txt"], { cwd: seedPath });
    await git(seedPath, ["commit", "-am", "Task change"]);
    const taskCommit = (await git(seedPath, ["rev-parse", "HEAD"])).stdout.trim();
    await git(seedPath, ["push", "-u", "origin", "task/conflict"]);

    await git(seedPath, ["checkout", "main"]);
    await execFileAsync("sh", ["-lc", "printf 'main change\\n' > conflict.txt"], { cwd: seedPath });
    await git(seedPath, ["commit", "-am", "Main change"]);
    await git(seedPath, ["push", "origin", "main"]);
    await execFileAsync("git", ["clone", originPath, repositoryPath]);
    await git(repositoryPath, ["branch", "task/conflict", "origin/task/conflict"]);

    await insertProject({
      id: projectId,
      name: "Integration Agent Smoke",
      slug: `integration-agent-smoke-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `integration-agent-smoke-${projectId.slice(0, 8)}`,
      repositoryUrl: originPath,
      localRepositoryPath: repositoryPath,
      actorId: adminId,
    });
    const task = await insertTask({
      projectId,
      title: "Resolve a real merge conflict",
      description: "Integration Agent smoke test",
      acceptanceCriteria: "Conflict is resolved with both intents represented",
      verificationCommands: ["grep -q 'resolved main + task' conflict.txt"],
      assignedUserId: adminId,
      actorId: adminId,
    });
    await query(
      `UPDATE tasks
          SET status = 'submitted', base_commit = $2, branch_name = 'task/conflict'
        WHERE id = $1`,
      [task.id, baseCommit],
    );
    const changeRequest = await insertChangeRequest({
      taskId: task.id,
      summary: "Create a conflicting task change for Integration Agent verification.",
      baseCommit,
      headCommit: taskCommit,
      changedFiles: [{ path: "conflict.txt", status: "M" }],
      diffStat: "1 file changed",
      verificationResults: [],
      risks: [],
      actorId: adminId,
    });
    await query(
      "UPDATE change_requests SET status = 'approved_for_integration' WHERE id = $1",
      [changeRequest.id],
    );

    await writeSecret(credentialRef, { api_key: integrationApiKey });
    await insertAgentConnection({
      id: connectionId,
      userId: adminId,
      provider: "mock-integration",
      displayName: "Mock Integration ACP",
      protocol: "acp",
      launcherCommand: "node",
      launcherArguments: ["/tmp/mock-integration-agent.mjs"],
      credentialEnvironmentVariable: "MOCK_API_KEY",
      credentialRef,
    });

    const integration = await startIntegration(changeRequest.id, adminId);
    integrationId = integration.id;
    if (integration.status !== "needs_agent") {
      throw new Error(`Expected needs_agent, got ${integration.status}`);
    }
    const runner = await getIntegrationRunner(integration.id);
    if (!runner) {
      throw new Error("Integration Runner was not created");
    }
    await execFileAsync("docker", [
      "cp",
      path.join(repositoryRoot, "scripts/fixtures/mock-integration-agent.mjs"),
      `${runner.containerName}:/tmp/mock-integration-agent.mjs`,
    ]);

    const result = await runIntegrationAgent(
      integration.id,
      {
        agentConnectionId: connectionId,
        prompt: "Resolve the real conflict, verify the repository, and create the merge commit.",
      },
      adminId,
    );
    if (result.integration.status !== "awaiting_final_approval") {
      throw new Error(`Integration Agent did not reach final approval: ${result.integration.status}`);
    }
    const ancestry = await git(result.integration.worktreePath, [
      "merge-base",
      "--is-ancestor",
      taskCommit,
      "HEAD",
    ]);
    if (ancestry.stderr) {
      throw new Error(ancestry.stderr);
    }
    const sessions = await listIntegrationAgentSessions(integration.id);
    if (sessions.length !== 1 || sessions[0]?.status !== "completed") {
      throw new Error(`Integration session was not persisted: ${JSON.stringify(sessions)}`);
    }
    const refreshedConnection = await getAgentConnection(connectionId);
    if (!refreshedConnection.credentialLastUsedAt) {
      throw new Error("Integration Agent credential usage time was not recorded");
    }
    const credentialEvents = await listCredentialAccessEvents(connectionId);
    const usedEvent = credentialEvents.find(
      (event) =>
        event.eventType === "used" &&
        event.integrationId === integration.id &&
        event.sessionId === result.session.id &&
        event.runnerId === runner.id,
    );
    if (!usedEvent) {
      throw new Error(`Integration credential usage was not audited: ${JSON.stringify(credentialEvents)}`);
    }
    if (JSON.stringify(usedEvent.metadata).includes(integrationApiKey)) {
      throw new Error("Integration credential plaintext leaked into the audit event");
    }

    console.log(JSON.stringify({
      integrationId: integration.id,
      integrationStatus: result.integration.status,
      sessionId: result.session.id,
      mergeCommit: result.integration.mergeCommit,
      eventCount: sessions[0].events?.length ?? 0,
      credentialUseAudited: true,
    }));
  } finally {
    if (integrationId) {
      const runner = await getIntegrationRunner(integrationId).catch(() => null);
      if (runner) {
        await destroyRunner(runner).catch(() => undefined);
      }
    }
    await query("DELETE FROM audit_events WHERE project_id = $1", [projectId]).catch(
      () => undefined,
    );
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await query("DELETE FROM agent_connections WHERE id = $1", [connectionId]).catch(() => undefined);
    await deleteSecret(credentialRef).catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
