import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { deleteSecret } from "../apps/control-plane/src/lib/openbao";
import {
  insertProject,
  insertTask,
  listAgentCredentialLeases,
  updateTaskWorkspace,
} from "../apps/control-plane/src/lib/repositories";
import { destroyRunner, launchTaskRunner } from "../apps/control-plane/src/lib/runner";
import { createAgentConnection, runTaskAgent } from "../apps/control-plane/src/lib/services";
import type { TaskRunner } from "../apps/control-plane/src/lib/types";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerId = randomUUID();
const projectId = randomUUID();
const runtimePath = path.join(config.runtimeRoot, "credential-lease-runtime-smoke", projectId);
const apiKey = `cloudagent-lease-runtime-${randomUUID()}`;

async function main() {
  let connectionId: string | null = null;
  let runner: TaskRunner | null = null;
  try {
    if (config.credentials.leaseTtlSeconds !== 1) {
      throw new Error(`Expected a one-second lease, received ${config.credentials.leaseTtlSeconds}`);
    }
    await mkdir(runtimePath, { recursive: true });
    await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
      ownerId,
      `credential-lease-runtime-${ownerId.slice(0, 8)}@cloudagent.local`,
      "Credential Lease Runtime Owner",
    ]);
    await query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
      [config.organizationId, ownerId],
    );
    await insertProject({
      id: projectId,
      name: "Credential Lease Runtime Smoke",
      slug: `credential-lease-runtime-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `credential-lease-runtime-${projectId.slice(0, 8)}`,
      repositoryUrl: runtimePath,
      localRepositoryPath: runtimePath,
      actorId: ownerId,
    });
    const connection = await createAgentConnection(
      {
        displayName: "Lease Runtime ACP Agent",
        provider: "lease-runtime-smoke",
        protocol: "acp",
        launcherCommand: "node",
        launcherArguments: ["/tmp/mock-acp-agent.mjs"],
        credentialEnvironmentVariable: "LEASE_RUNTIME_API_KEY",
        apiKey,
      },
      ownerId,
    );
    connectionId = connection.id;
    const task = await insertTask({
      projectId,
      title: "Stop an Agent when its credential lease expires",
      description: "Run a waiting ACP Agent longer than the one-second credential lease.",
      acceptanceCriteria: "The session stops with credential_lease_expired.",
      verificationCommands: [],
      assignedUserId: ownerId,
      agentConnectionId: connection.id,
      actorId: ownerId,
    });
    await updateTaskWorkspace({
      taskId: task.id,
      baseCommit: "credential-lease-runtime-base",
      branchName: `task/${task.id}`,
      worktreePath: runtimePath,
    });
    runner = await launchTaskRunner(task.id, runtimePath);
    await execFileAsync("docker", [
      "cp",
      path.join(repositoryRoot, "scripts/fixtures/mock-acp-agent.mjs"),
      `${runner.containerName}:/tmp/mock-acp-agent.mjs`,
    ]);

    const startedAt = Date.now();
    const session = await runTaskAgent(
      task.id,
      { prompt: "Please cancel this ACP turn after the credential lease expires." },
      ownerId,
    );
    const durationMs = Date.now() - startedAt;
    if (
      session.status !== "stopped" ||
      session.stopReason !== "credential_lease_expired" ||
      session.errorMessage !== null
    ) {
      throw new Error(`Expired lease did not stop the Agent session: ${JSON.stringify(session)}`);
    }
    if (durationMs < 750 || durationMs > 10_000) {
      throw new Error(`Credential lease enforcement took ${durationMs}ms`);
    }
    const leases = await listAgentCredentialLeases(ownerId);
    if (
      leases.length !== 1 ||
      leases[0]?.sessionId !== session.id ||
      leases[0]?.status !== "expired" ||
      leases[0]?.releaseReason !== "ttl_expired"
    ) {
      throw new Error(`Runtime lease state is incorrect: ${JSON.stringify(leases)}`);
    }

    console.log(
      JSON.stringify({
        credentialLeaseTtlSeconds: config.credentials.leaseTtlSeconds,
        agentSessionStoppedOnExpiry: true,
        stopReason: session.stopReason,
        durationMs,
        expiredLeasePersisted: true,
      }),
    );
  } finally {
    if (runner) {
      await destroyRunner(runner).catch(() => undefined);
    }
    if (connectionId) {
      await deleteSecret(`openbao://secret/agent-connections/${connectionId}`).catch(
        () => undefined,
      );
    }
    await query("DELETE FROM audit_events WHERE project_id = $1 OR actor_id = $2", [
      projectId,
      ownerId,
    ]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    if (connectionId) {
      await query("DELETE FROM agent_connections WHERE id = $1", [connectionId]).catch(
        () => undefined,
      );
    }
    await query("DELETE FROM memberships WHERE user_id = $1", [ownerId]).catch(() => undefined);
    await query("DELETE FROM users WHERE id = $1", [ownerId]).catch(() => undefined);
    await rm(runtimePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
