import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { deleteSecret, writeSecret } from "../apps/control-plane/src/lib/openbao";
import {
  addProjectMembership,
  getAgentConnection,
  getProjectMergePlanAgentRun,
  getProjectMergePlanRunner,
  insertAgentConnection,
  insertChangeRequest,
  insertProject,
  insertTask,
  listCredentialAccessEvents,
  listProjectMergePlanAgentSessions,
} from "../apps/control-plane/src/lib/repositories";
import {
  queueProjectMergePlanAgentRun,
} from "../apps/control-plane/src/lib/services";
import { durableRunProjectMergePlanAgent } from "../apps/control-plane/src/temporal/client";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adminId = "00000000-0000-4000-8000-000000000101";
const memberId = "00000000-0000-4000-8000-000000000102";
const projectId = randomUUID();
const connectionId = randomUUID();
const projectRoot = path.join(config.runtimeRoot, "projects", projectId);
const originPath = path.join(projectRoot, "origin.git");
const seedPath = path.join(projectRoot, "seed");
const repositoryPath = path.join(projectRoot, "repository");
const credentialRef = `openbao://secret/agent-connections/${connectionId}`;
const mockApiKey = "branchharbor-merge-plan-smoke-key";

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function main() {
  let mergePlanRunId: string | null = null;
  try {
    await mkdir(path.join(seedPath, ".branchharbor"), { recursive: true });
    await execFileAsync("git", ["init", "--bare", originPath]);
    await execFileAsync("git", ["init", seedPath]);
    await git(seedPath, ["config", "user.name", "BranchHarbor Smoke"]);
    await git(seedPath, ["config", "user.email", "smoke@branchharbor.local"]);
    await git(seedPath, ["checkout", "-b", "main"]);
    await copyFile(
      path.join(repositoryRoot, "scripts/fixtures/mock-merge-plan-agent.mjs"),
      path.join(seedPath, ".branchharbor/mock-merge-plan-agent.mjs"),
    );
    await execFileAsync("sh", ["-lc", "mkdir -p src && printf 'export interface Contract { value: string }\\n' > src/contract.ts"], {
      cwd: seedPath,
    });
    await git(seedPath, ["add", "."]);
    await git(seedPath, ["commit", "-m", "Seed semantic merge planning fixture"]);
    const mainCommit = (await git(seedPath, ["rev-parse", "HEAD"])).stdout.trim();
    await git(seedPath, ["remote", "add", "origin", originPath]);
    await git(seedPath, ["push", "-u", "origin", "main"]);
    await execFileAsync("git", ["--git-dir", originPath, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await execFileAsync("git", ["clone", originPath, repositoryPath]);

    await insertProject({
      id: projectId,
      name: "Merge Planning Agent Smoke",
      slug: `merge-plan-agent-smoke-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `merge-plan-agent-smoke-${projectId.slice(0, 8)}`,
      repositoryUrl: originPath,
      localRepositoryPath: repositoryPath,
      actorId: adminId,
    });
    const foundation = await insertTask({
      projectId,
      title: "Define shared contract",
      description: "Create the shared contract used by downstream work.",
      acceptanceCriteria: "The contract is exported from src/contract.ts.",
      verificationCommands: [],
      expectedChangeScopes: ["src/contract.ts"],
      assignedUserId: adminId,
      actorId: adminId,
    });
    const dependent = await insertTask({
      projectId,
      title: "Consume shared contract",
      description: "Use the shared contract in the API consumer.",
      acceptanceCriteria: "The consumer compiles against the contract.",
      verificationCommands: [],
      expectedChangeScopes: ["src/consumer.ts"],
      dependsOnTaskIds: [foundation.id],
      assignedUserId: adminId,
      actorId: adminId,
    });
    const independent = await insertTask({
      projectId,
      title: "Update independent documentation",
      description: "Update a document unrelated to the shared contract.",
      acceptanceCriteria: "The document explains the feature.",
      verificationCommands: [],
      expectedChangeScopes: ["docs/feature.md"],
      assignedUserId: adminId,
      actorId: adminId,
    });
    await query("UPDATE tasks SET status = 'submitted', base_commit = $2 WHERE project_id = $1", [
      projectId,
      mainCommit,
    ]);
    for (const task of [foundation, dependent, independent]) {
      await insertChangeRequest({
        taskId: task.id,
        summary: `Completed ${task.title} for semantic merge planning.`,
        baseCommit: mainCommit,
        headCommit: mainCommit,
        changedFiles: [],
        diffStat: "0 files changed",
        verificationResults: [],
        risks: [],
        actorId: adminId,
      });
    }

    await writeSecret(credentialRef, { api_key: mockApiKey });
    await insertAgentConnection({
      id: connectionId,
      userId: adminId,
      provider: "mock-merge-plan",
      displayName: "Mock Merge Planning ACP",
      protocol: "acp",
      launcherCommand: "node",
      launcherArguments: [
        "/home/gem/project/.branchharbor/mock-merge-plan-agent.mjs",
        independent.id,
        foundation.id,
        dependent.id,
      ],
      credentialEnvironmentVariable: "MOCK_API_KEY",
      credentialRef,
    });

    await addProjectMembership({ projectId, userId: memberId, addedBy: adminId });
    let memberRejected = false;
    try {
      await queueProjectMergePlanAgentRun(
        projectId,
        {
          agentConnectionId: connectionId,
          instruction: "A normal project member must not be able to start Admin semantic planning.",
        },
        memberId,
      );
    } catch {
      memberRejected = true;
    }
    if (!memberRejected) {
      throw new Error("A normal project member started an Admin Merge Planning Agent run");
    }

    const queued = await queueProjectMergePlanAgentRun(
      projectId,
      {
        agentConnectionId: connectionId,
        instruction: "Inspect semantic dependencies and propose a safe order without changing files.",
      },
      adminId,
    );
    mergePlanRunId = queued.id;
    await durableRunProjectMergePlanAgent({ runId: queued.id, actorId: adminId });
    let completed = queued;
    const deadline = Date.now() + 120_000;
    while (["starting", "running"].includes(completed.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      completed = await getProjectMergePlanAgentRun(queued.id);
    }
    if (completed.status !== "completed" || !completed.suggestion) {
      throw new Error(`Merge Planning Agent did not complete: ${JSON.stringify(completed)}`);
    }
    const expectedOrder = [independent.id, foundation.id, dependent.id];
    if (JSON.stringify(completed.suggestion.recommendedTaskIds) !== JSON.stringify(expectedOrder)) {
      throw new Error(`Unexpected semantic order: ${JSON.stringify(completed.suggestion)}`);
    }
    if (!completed.suggestion.differsFromBaseline) {
      throw new Error("Semantic suggestion should differ from the deterministic baseline");
    }
    const sessions = await listProjectMergePlanAgentSessions(completed.id);
    if (sessions.length !== 1 || sessions[0]?.status !== "completed") {
      throw new Error(`Planning session was not persisted: ${JSON.stringify(sessions)}`);
    }
    if (sessions[0]?.transportMetadata.workspaceMode !== "read-only") {
      throw new Error(`Read-only workspace evidence missing: ${JSON.stringify(sessions[0])}`);
    }
    let runner = await getProjectMergePlanRunner(completed.id);
    const cleanupDeadline = Date.now() + 30_000;
    while (runner?.status !== "destroyed" && Date.now() < cleanupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      runner = await getProjectMergePlanRunner(completed.id);
    }
    if (!runner || runner.status !== "destroyed") {
      throw new Error(`Planning Runner was not destroyed: ${JSON.stringify(runner)}`);
    }
    const refreshedConnection = await getAgentConnection(connectionId);
    if (!refreshedConnection.credentialLastUsedAt) {
      throw new Error("Merge Planning Agent credential usage was not recorded");
    }
    const credentialEvents = await listCredentialAccessEvents(connectionId);
    const usedEvent = credentialEvents.find(
      (event) =>
        event.eventType === "used" &&
        event.sessionId === sessions[0]?.id &&
        event.runnerId === runner.id &&
        event.taskId === null &&
        event.integrationId === null,
    );
    if (!usedEvent || JSON.stringify(usedEvent.metadata).includes(mockApiKey)) {
      throw new Error(`Credential audit is incomplete or leaked plaintext: ${JSON.stringify(credentialEvents)}`);
    }
    const activeLeases = await query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM agent_credential_leases WHERE runner_id = $1 AND status = 'active'",
      [runner.id],
    );
    if (activeLeases[0]?.count !== "0") {
      throw new Error("Merge Planning Agent credential lease was not released");
    }

    console.log(JSON.stringify({
      runId: completed.id,
      status: completed.status,
      recommendedTaskIds: completed.suggestion.recommendedTaskIds,
      semanticConflictCount: completed.suggestion.semanticConflicts.length,
      runnerDestroyed: true,
      readOnlyWorkspace: true,
      credentialUseAudited: true,
      memberRejected: true,
    }));
  } finally {
    if (mergePlanRunId) {
      await query("DELETE FROM workflow_executions WHERE entity_id = $1", [mergePlanRunId]).catch(
        () => undefined,
      );
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
