import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { AppError } from "../apps/control-plane/src/lib/errors";
import { deleteSecret, readSecret } from "../apps/control-plane/src/lib/openbao";
import {
  getAgentConnection,
  getAgentCredentialLease,
  getAgentPermissionRequest,
  getAgentSession,
  insertAgentPermissionRequest,
  insertAgentSession,
  insertProject,
  insertTask,
  insertTaskRunner,
  issueAgentCredentialLease,
  listAgentCredentialLeases,
  listCredentialAccessEvents,
  refreshAgentCredentialLease,
  releaseAgentCredentialLease,
  updateAgentSession,
} from "../apps/control-plane/src/lib/repositories";
import {
  configureAgentCredential,
  createAgentConnection,
  revokeAgentCredential,
} from "../apps/control-plane/src/lib/services";

const ownerId = randomUUID();
const otherMemberId = randomUUID();
const projectId = randomUUID();
const runnerId = randomUUID();
const runtimePath = path.join(config.runtimeRoot, "credential-lifecycle-smoke", projectId);
const firstApiKey = `cloudagent-credential-first-${randomUUID()}`;
const secondApiKey = `cloudagent-credential-second-${randomUUID()}`;
const thirdApiKey = `cloudagent-credential-third-${randomUUID()}`;
const fourthApiKey = `cloudagent-credential-fourth-${randomUUID()}`;

async function expectAppError(
  action: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AppError && error.code === expectedCode) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected ${expectedCode}`);
}

async function insertMember(userId: string, label: string) {
  await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
    userId,
    `credential-lifecycle-${label}-${userId.slice(0, 8)}@cloudagent.local`,
    `Credential ${label}`,
  ]);
  await query(
    "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
    [config.organizationId, userId],
  );
}

async function expectSecretMissing(credentialRef: string) {
  await expectAppError(() => readSecret(credentialRef), "OPENBAO_REQUEST_FAILED");
}

async function main() {
  let connectionId: string | null = null;
  let credentialRef: string | null = null;
  try {
    await Promise.all([
      insertMember(ownerId, "owner"),
      insertMember(otherMemberId, "other"),
      mkdir(runtimePath, { recursive: true }),
    ]);
    await insertProject({
      id: projectId,
      name: "Credential Lifecycle Smoke",
      slug: `credential-lifecycle-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `credential-lifecycle-${projectId.slice(0, 8)}`,
      repositoryUrl: runtimePath,
      localRepositoryPath: runtimePath,
      actorId: ownerId,
    });

    const created = await createAgentConnection(
      {
        displayName: "Credential Lifecycle Agent",
        provider: "credential-smoke",
        protocol: "acp",
        launcherCommand: "node",
        launcherArguments: ["/tmp/credential-smoke-agent.mjs"],
        credentialEnvironmentVariable: "CREDENTIAL_SMOKE_API_KEY",
        apiKey: firstApiKey,
      },
      ownerId,
    );
    connectionId = created.id;
    credentialRef = `openbao://secret/agent-connections/${connectionId}`;
    if (!created.credentialConfigured || created.credentialVersion !== 1) {
      throw new Error(`Initial credential lifecycle is invalid: ${JSON.stringify(created)}`);
    }
    if ((await readSecret(credentialRef)).api_key !== firstApiKey) {
      throw new Error("Initial OpenBao credential was not persisted");
    }

    const rotated = await configureAgentCredential(
      connectionId,
      { apiKey: secondApiKey, model: "credential-smoke-model" },
      ownerId,
    );
    if (!rotated.credentialConfigured || rotated.credentialVersion !== 2) {
      throw new Error(`Credential rotation did not advance version: ${JSON.stringify(rotated)}`);
    }
    if ((await readSecret(credentialRef)).api_key !== secondApiKey) {
      throw new Error("Rotated OpenBao credential was not persisted");
    }
    await expectAppError(
      () => revokeAgentCredential(connectionId!, otherMemberId),
      "FORBIDDEN",
    );

    const task = await insertTask({
      projectId,
      title: "Cancel active Agent on credential revocation",
      description: "Credential lifecycle smoke task",
      acceptanceCriteria: "Active sessions and permissions are cancelled",
      verificationCommands: [],
      assignedUserId: ownerId,
      agentConnectionId: connectionId,
      actorId: ownerId,
    });
    await insertTaskRunner({
      id: runnerId,
      taskId: task.id,
      containerName: `credential-lifecycle-${runnerId}`,
      image: "credential-lifecycle-smoke",
      workspacePath: runtimePath,
      containerWorkspacePath: "/workspace",
      credentialRef: `openbao://secret/runners/${runnerId}`,
      resourceLimits: {},
    });
    const session = await insertAgentSession({
      taskId: task.id,
      agentConnectionId: connectionId,
      runnerId,
      prompt: "Wait for credential revocation.",
    });
    await updateAgentSession({ sessionId: session.id, status: "running" });
    const permission = await insertAgentPermissionRequest({
      sessionId: session.id,
      providerRequestId: "credential-lifecycle-permission",
      toolCall: { title: "Read protected resource", kind: "read" },
      options: [{ optionId: "allow_once", name: "Allow once" }],
    });
    const revokedLease = await issueAgentCredentialLease({
      connectionId,
      credentialVersion: rotated.credentialVersion,
      actorId: ownerId,
      taskId: task.id,
      sessionId: session.id,
      runnerId,
      ttlSeconds: 60,
    });
    if ((await getAgentCredentialLease(revokedLease.id)).status !== "active") {
      throw new Error("New credential lease was not active");
    }

    const revoked = await revokeAgentCredential(connectionId, ownerId);
    if (
      revoked.credentialConfigured ||
      revoked.status !== "disabled" ||
      revoked.credentialVersion !== 2 ||
      !revoked.credentialRevokedAt
    ) {
      throw new Error(`Credential was not revoked correctly: ${JSON.stringify(revoked)}`);
    }
    const internalRevoked = await getAgentConnection(connectionId);
    if (internalRevoked.credentialRef !== null) {
      throw new Error("Revoked credential reference remains in the database");
    }
    await expectSecretMissing(credentialRef);

    const cancelledSession = await getAgentSession(session.id);
    if (!cancelledSession.cancelRequestedAt || cancelledSession.cancelledBy !== ownerId) {
      throw new Error(`Active Agent session was not cancelled: ${JSON.stringify(cancelledSession)}`);
    }
    const cancelledPermission = await getAgentPermissionRequest(permission.id);
    if (cancelledPermission.status !== "cancelled" || cancelledPermission.resolvedBy !== ownerId) {
      throw new Error(
        `Pending permission was not cancelled: ${JSON.stringify(cancelledPermission)}`,
      );
    }
    const revokedLeaseState = await getAgentCredentialLease(revokedLease.id);
    if (
      revokedLeaseState.status !== "revoked" ||
      revokedLeaseState.releaseReason !== "credential_revoked" ||
      !revokedLeaseState.releasedAt
    ) {
      throw new Error(
        `Credential revocation did not revoke its active lease: ${JSON.stringify(revokedLeaseState)}`,
      );
    }

    const eventsAfterRevoke = await listCredentialAccessEvents(connectionId);
    const revokedEvents = eventsAfterRevoke.filter((event) => event.eventType === "revoked");
    if (
      !eventsAfterRevoke.some(
        (event) => event.eventType === "configured" && event.credentialVersion === 1,
      ) ||
      !eventsAfterRevoke.some(
        (event) => event.eventType === "rotated" && event.credentialVersion === 2,
      ) ||
      revokedEvents.length !== 1 ||
      revokedEvents[0]?.credentialVersion !== 2
    ) {
      throw new Error(`Credential audit events are incomplete: ${JSON.stringify(eventsAfterRevoke)}`);
    }
    await revokeAgentCredential(connectionId, ownerId);
    if (
      (await listCredentialAccessEvents(connectionId)).filter(
        (event) => event.eventType === "revoked",
      ).length !== 1
    ) {
      throw new Error("Repeated revocation created a duplicate audit event");
    }

    const reconfigured = await configureAgentCredential(
      connectionId,
      { apiKey: thirdApiKey },
      ownerId,
    );
    if (
      !reconfigured.credentialConfigured ||
      reconfigured.status !== "ready" ||
      reconfigured.credentialVersion !== 3 ||
      reconfigured.credentialRevokedAt !== null
    ) {
      throw new Error(`Credential was not restored correctly: ${JSON.stringify(reconfigured)}`);
    }
    if ((await readSecret(credentialRef)).api_key !== thirdApiKey) {
      throw new Error("Reconfigured OpenBao credential was not persisted");
    }

    const rotationLease = await issueAgentCredentialLease({
      connectionId,
      credentialVersion: reconfigured.credentialVersion,
      actorId: ownerId,
      taskId: task.id,
      sessionId: session.id,
      runnerId,
      ttlSeconds: 60,
    });
    const rerotated = await configureAgentCredential(
      connectionId,
      { apiKey: fourthApiKey },
      ownerId,
    );
    const rotationLeaseState = await refreshAgentCredentialLease(rotationLease.id);
    if (
      rerotated.credentialVersion !== 4 ||
      rotationLeaseState.status !== "revoked" ||
      rotationLeaseState.releaseReason !== "credential_changed"
    ) {
      throw new Error(
        `Credential rotation did not invalidate the old lease: ${JSON.stringify({ rerotated, rotationLeaseState })}`,
      );
    }
    if ((await readSecret(credentialRef)).api_key !== fourthApiKey) {
      throw new Error("Second rotated OpenBao credential was not persisted");
    }

    const expiringLease = await issueAgentCredentialLease({
      connectionId,
      credentialVersion: rerotated.credentialVersion,
      actorId: ownerId,
      taskId: task.id,
      sessionId: session.id,
      runnerId,
      ttlSeconds: 0.05,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const expiredLeaseState = await refreshAgentCredentialLease(expiringLease.id);
    if (
      expiredLeaseState.status !== "expired" ||
      expiredLeaseState.releaseReason !== "ttl_expired" ||
      !expiredLeaseState.releasedAt
    ) {
      throw new Error(`Credential lease did not expire: ${JSON.stringify(expiredLeaseState)}`);
    }

    const releasableLease = await issueAgentCredentialLease({
      connectionId,
      credentialVersion: rerotated.credentialVersion,
      actorId: ownerId,
      taskId: task.id,
      sessionId: session.id,
      runnerId,
      ttlSeconds: 60,
    });
    const releasedLeaseState = await releaseAgentCredentialLease({
      leaseId: releasableLease.id,
      reason: "agent_execution_finished",
    });
    if (
      releasedLeaseState.status !== "released" ||
      releasedLeaseState.releaseReason !== "agent_execution_finished" ||
      !releasedLeaseState.releasedAt
    ) {
      throw new Error(`Credential lease was not released: ${JSON.stringify(releasedLeaseState)}`);
    }
    const leaseHistory = await listAgentCredentialLeases(ownerId);
    const leaseStatuses = new Set(leaseHistory.map((lease) => lease.status));
    if (
      !leaseStatuses.has("revoked") ||
      !leaseStatuses.has("expired") ||
      !leaseStatuses.has("released")
    ) {
      throw new Error(`Credential lease history is incomplete: ${JSON.stringify(leaseHistory)}`);
    }

    const [storedText] = await query<{ content: string }>(
      `SELECT CONCAT(
         COALESCE((SELECT STRING_AGG(payload::TEXT, '') FROM audit_events WHERE actor_id IN ($1,$2)), ''),
         COALESCE((SELECT STRING_AGG(metadata::TEXT, '') FROM credential_access_events WHERE actor_id IN ($1,$2)), ''),
         COALESCE((SELECT STRING_AGG(COALESCE(credential_ref, ''), '') FROM agent_connections WHERE id = $3), '')
       ) AS content`,
      [ownerId, otherMemberId, connectionId],
    );
    const leakedKey = [firstApiKey, secondApiKey, thirdApiKey, fourthApiKey].find((key) =>
      storedText?.content.includes(key),
    );
    if (leakedKey) {
      throw new Error("Plaintext credential leaked into database audit data");
    }

    const finalEvents = await listCredentialAccessEvents(connectionId);
    console.log(
      JSON.stringify({
        initialVersion: created.credentialVersion,
        rotatedVersion: rotated.credentialVersion,
        revokedVersion: revoked.credentialVersion,
        restoredVersion: reconfigured.credentialVersion,
        finalVersion: rerotated.credentialVersion,
        unauthorizedRevocationRejected: true,
        activeSessionCancelled: true,
        pendingPermissionCancelled: true,
        secretDeletedOnRevoke: true,
        duplicateRevocationAuditPrevented: true,
        credentialRevocationRevokedLease: true,
        credentialRotationRevokedLease: true,
        credentialLeaseExpiredAutomatically: true,
        credentialLeaseReleasedAfterExecution: true,
        credentialLeaseHistoryVisible: true,
        plaintextCredentialAbsentFromDatabase: true,
        eventTypes: finalEvents.map((event) => event.eventType),
      }),
    );
  } finally {
    if (credentialRef) {
      await deleteSecret(credentialRef).catch(() => undefined);
    }
    await query("DELETE FROM audit_events WHERE project_id = $1 OR actor_id IN ($2,$3)", [
      projectId,
      ownerId,
      otherMemberId,
    ]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    if (connectionId) {
      await query("DELETE FROM agent_connections WHERE id = $1", [connectionId]).catch(
        () => undefined,
      );
    }
    await query("DELETE FROM memberships WHERE user_id IN ($1,$2)", [ownerId, otherMemberId]).catch(
      () => undefined,
    );
    await query("DELETE FROM users WHERE id IN ($1,$2)", [ownerId, otherMemberId]).catch(
      () => undefined,
    );
    await rm(runtimePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
