import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";

import { parseAuditQuery } from "./audit";
import { config } from "./config";
import {
  createInvitationToken,
  hashInvitationToken,
  hashPassword,
  verifyPassword,
} from "./auth-crypto";
import {
  runAcpSession,
  runCodexSession,
  runOpenAiCompatibleSession,
  type AgentSessionCallbacks,
  type ParsedAgentOutput,
} from "./agent-gateway";
import {
  assertCredentialOwner,
  assertOrganizationAdmin,
  assertOrganizationMember,
  assertTaskOperator,
  requireTaskMembership,
} from "./authorization";
import {
  assertChangeRequestTransition,
  assertTaskTransition,
  type ReviewDecision,
} from "./domain";
import { AppError } from "./errors";
import { withAdvisoryLock } from "./db";
import {
  cloneRepository,
  createProjectMergePlanWorktree,
  createProjectValidationWorktree,
  createTaskWorktree,
  ensureRepositoryClone,
  finalizeIntegrationGit,
  inspectCommittedChanges,
  inspectTaskWorkspaceProgress,
  prepareIntegrationWorktree,
  removeProjectMergePlanWorktree,
  removeProjectValidationWorktree,
  removeTaskWorktree,
  restoreTaskWorkspaceBackup,
  runGit,
  runVerificationCommands,
  syncTaskWorkspaceBackup,
} from "./git";
import { createGiteaRepository, ensureMainBranchProtection } from "./gitea";
import { findFilesOutsideTaskScopes } from "./task-coordination";
import {
  buildIntegrationQueueGate,
  buildIntegrationQueueTaskOrder,
  type IntegrationQueueGate,
} from "./integration-queue";
import {
  buildProjectMergePlan,
  buildSemanticMergePlanPrompt,
  parseSemanticMergePlanSuggestion,
} from "./merge-planning";
import {
  getChangeRequest,
  getAgentConnection,
  getIntegrationRunner,
  getIntegrationRun,
  getProjectMergePlanAgentRun,
  getAgentPermissionRequest,
  getAgentSession,
  getLatestChangeRequestForTask,
  getLatestIntegrationForChangeRequest,
  getLatestProjectMergePlanAgentRun as getLatestProjectMergePlanAgentRunRecord,
  getActiveProjectIntegrationQueue,
  getProjectIntegrationQueueRecord,
  getProjectValidationRun,
  getProjectValidationRunner,
  getTaskWorkspaceBackup as getTaskWorkspaceBackupRecord,
  listAuditEvents,
  listAuditEventTypes,
  listBlockingTaskDependencies,
  listLatestTaskWorkspaceSnapshots,
  listLatestChangeRequestsForProject,
  listProjectNotifications,
  listProjectIntegrationQueues,
  listProjectValidationRuns,
  listTaskDependencies,
  listTaskDependenciesForTask,
  listTaskDependencyRevisions,
  listTaskScopeConflicts,
  listTaskWorkspaceSnapshots,
  listTasks,
  markProjectNotificationRecordsRead,
  getProjectAccessRole,
  getTaskPreviewRun,
  getOrganizationRole,
  getProject,
  getTask,
  getTaskRunner,
  insertChangeRequest,
  addProjectMembership,
  insertAgentConnection,
  appendAgentEvent,
  cancelTaskState,
  captureTaskWorkspaceSnapshot,
  clearTaskWorktree,
  acceptMembershipInvitationRecord,
  findMembershipInvitationByTokenHash,
  findUserCredentialById,
  insertAgentPermissionRequest,
  insertAgentSession,
  insertTaskPreviewRun,
  insertMembershipInvitation,
  insertIntegrationRun,
  insertProjectMergePlanAgentRun,
  insertProjectValidationRun,
  insertProject,
  insertTask,
  issueAgentCredentialLease,
  isAgentCredentialLeaseActive,
  markMerged,
  markAgentCredentialConfigured,
  markAgentCredentialRevoked,
  markAgentCredentialUsed,
  recordAudit,
  recordCredentialAccessEvent,
  recordReview,
  recordTaskWorkspaceBackup,
  recordTaskWorkspaceBackupFailure,
  refreshAgentCredentialLease,
  releaseAgentCredentialLease,
  removeProjectMembership,
  recoverFailedTaskDependencyRecord,
  replaceTaskDependencies,
  resolveAgentPermissionRequest,
  requestAgentSessionCancellation,
  revokeAllAuthSessionsForUser,
  revokeMembershipInvitationRecord,
  isAgentSessionCancellationRequested,
  setTaskStatus,
  updateIntegrationRun,
  updateProjectMergePlanAgentRun,
  updateProjectValidationRun,
  updateAgentSession,
  updateTaskPreviewRun,
  updateUserPassword,
  updateTaskWorkspace,
  countOpenTasksForProjectMember,
  cancelProjectIntegrationQueueRecord,
  refreshProjectIntegrationQueueStatus,
  refreshQueuedChangeRequestForTask,
  replaceProjectIntegrationQueueRecord,
} from "./repositories";
import {
  launchIntegrationRunner,
  launchProjectMergePlanRunner,
  launchProjectValidationRunner,
  launchTaskRunner,
  rebuildTaskRunnerAfterWorkspaceRestore,
  executeInRunner,
  readRunnerPreviewProcess,
  runVerificationInRunner,
  runnerPreviewUrl,
  startRunnerPreviewProcess,
  stopRunnerPreviewProcess,
  destroyRunner,
  waitForRunnerPreview,
} from "./runner";
import { deleteSecret, readSecret, writeSecret } from "./openbao";
import {
  createProjectSchema,
  createTaskSchema,
  configureAgentCredentialSchema,
  createAgentConnectionSchema,
  agentPromptSchema,
  acceptMembershipInvitationSchema,
  changePasswordSchema,
  createMembershipInvitationSchema,
  integrationAgentPromptSchema,
  projectMergePlanAgentSchema,
  projectIntegrationQueueSchema,
  cancelProjectIntegrationQueueSchema,
  projectValidationRunSchema,
  resolveAgentPermissionSchema,
  projectMemberSchema,
  reviewSchema,
  startTaskPreviewSchema,
  submitChangeRequestSchema,
  markProjectNotificationsReadSchema,
  recoverTaskDependencySchema,
  updateTaskDependenciesSchema,
} from "./validation";
import type {
  AgentConnection,
  Project,
  Task,
  TaskPreviewRun,
  TaskRunner,
  VerificationResult,
} from "./types";

export async function getOrganizationAuditLog(input: unknown, actorId: string) {
  assertOrganizationAdmin(await getOrganizationRole(actorId, config.organizationId));
  return listAuditEvents(config.organizationId, parseAuditQuery(input));
}

export async function getOrganizationAuditEventTypes(actorId: string): Promise<string[]> {
  assertOrganizationAdmin(await getOrganizationRole(actorId, config.organizationId));
  return listAuditEventTypes(config.organizationId);
}

export async function createMembershipInvitation(input: unknown, actorId: string) {
  assertOrganizationAdmin(await getOrganizationRole(actorId, config.organizationId));
  const data = createMembershipInvitationSchema.parse(input);
  const token = createInvitationToken();
  const invitation = await insertMembershipInvitation({
    organizationId: config.organizationId,
    email: data.email,
    name: data.name,
    role: data.role,
    tokenHash: hashInvitationToken(token),
    expiresAt: new Date(Date.now() + data.expiresInHours * 60 * 60 * 1000),
    invitedBy: actorId,
  });
  return { invitation, invitePath: `/invite/${token}` };
}

export async function revokeMembershipInvitation(invitationId: string, actorId: string) {
  assertOrganizationAdmin(await getOrganizationRole(actorId, config.organizationId));
  await revokeMembershipInvitationRecord({
    invitationId,
    organizationId: config.organizationId,
    actorId,
  });
}

export async function getMembershipInvitation(token: string) {
  if (token.length < 32 || token.length > 200) {
    return null;
  }
  return findMembershipInvitationByTokenHash(hashInvitationToken(token));
}

export async function acceptMembershipInvitation(input: unknown) {
  const data = acceptMembershipInvitationSchema.parse(input);
  const passwordHash = await hashPassword(data.password);
  return acceptMembershipInvitationRecord({
    tokenHash: hashInvitationToken(data.token),
    passwordHash,
  });
}

export async function changeOwnPassword(input: unknown, actorId: string) {
  const data = changePasswordSchema.parse(input);
  const credential = await findUserCredentialById(actorId);
  if (!credential) {
    throw new AppError("Account credential not found", 404, "CREDENTIAL_NOT_FOUND");
  }
  if (!(await verifyPassword(data.currentPassword, credential.passwordHash))) {
    throw new AppError("Current password is incorrect", 401, "CURRENT_PASSWORD_INVALID");
  }
  await updateUserPassword({
    userId: actorId,
    passwordHash: await hashPassword(data.newPassword),
  });
  await revokeAllAuthSessionsForUser(actorId);
  await recordAudit({
    actorId,
    eventType: "auth.password_changed",
  });
}

function assertPreviewOperator(input: {
  actorId: string;
  assignedUserId: string;
  role: "admin" | "member" | null;
}) {
  assertTaskOperator(input);
}

export async function startTaskPreview(taskId: string, input: unknown, actorId: string) {
  const data = startTaskPreviewSchema.parse(input);
  const task = await getTask(taskId);
  const project = await getProject(task.projectId);
  const role = await getProjectAccessRole(actorId, project.id);
  assertPreviewOperator({ actorId, assignedUserId: task.assignedUserId, role });
  if (!task.worktreePath) {
    throw new AppError("Create the task Worktree first", 409, "TASK_WORKSPACE_NOT_READY");
  }
  const runner = await getTaskRunner(task.id);
  if (!runner || runner.status !== "running") {
    throw new AppError("Start the task Runner first", 409, "RUNNER_NOT_RUNNING");
  }

  const previewId = randomUUID();
  const shellSessionId = `branchharbor-preview-${previewId}`;
  const directPreviewUrl = runnerPreviewUrl(runner, data.port, previewId);
  const previewUrl = `/api/task-previews/${previewId}/proxy/`;
  const preview = await insertTaskPreviewRun({
    id: previewId,
    taskId: task.id,
    runnerId: runner.id,
    command: data.command,
    port: data.port,
    shellSessionId,
    previewUrl,
    startedBy: actorId,
  });

  try {
    await startRunnerPreviewProcess(runner, {
      sessionId: shellSessionId,
      command: data.command,
      port: data.port,
    });
    await waitForRunnerPreview(directPreviewUrl);
    const process = await readRunnerPreviewProcess(runner, shellSessionId);
    const running = await updateTaskPreviewRun({
      previewId,
      status: "running",
      output: process.output.slice(-50_000),
      exitCode: null,
      errorMessage: null,
    });
    await recordAudit({
      actorId,
      projectId: project.id,
      taskId: task.id,
      eventType: "task_preview.started",
      payload: { previewId, port: data.port, command: data.command },
    });
    return running;
  } catch (error) {
    const process = await readRunnerPreviewProcess(runner, shellSessionId).catch(() => null);
    await stopRunnerPreviewProcess(runner, shellSessionId).catch(() => undefined);
    await updateTaskPreviewRun({
      previewId,
      status: "failed",
      output: process?.output.slice(-50_000) ?? "",
      exitCode: process?.exitCode ?? null,
      errorMessage: error instanceof Error ? error.message : String(error),
      ended: true,
    });
    throw error;
  }
}

export async function refreshTaskPreview(
  previewId: string,
  actorId: string,
): Promise<TaskPreviewRun> {
  const preview = await getTaskPreviewRun(previewId);
  const task = await getTask(preview.taskId);
  const project = await getProject(task.projectId);
  assertOrganizationMember(await getProjectAccessRole(actorId, project.id));
  if (!["starting", "running"].includes(preview.status)) {
    return preview;
  }
  const runner = await getTaskRunner(task.id);
  if (!runner || runner.id !== preview.runnerId || runner.status !== "running") {
    return updateTaskPreviewRun({
      previewId,
      status: "failed",
      output: preview.output,
      exitCode: preview.exitCode,
      errorMessage: "The task Runner has stopped, so the preview cannot continue",
      ended: true,
    });
  }
  const process = await readRunnerPreviewProcess(runner, preview.shellSessionId);
  const output = process.output.slice(-50_000);
  if (process.status === "running") {
    return updateTaskPreviewRun({
      previewId,
      status: "running",
      output,
      exitCode: null,
      errorMessage: null,
    });
  }
  if (process.status === "completed") {
    return updateTaskPreviewRun({
      previewId,
      status: process.exitCode === 0 ? "completed" : "failed",
      output,
      exitCode: process.exitCode,
      errorMessage: process.exitCode === 0 ? null : `Preview command exited with code ${process.exitCode}`,
      ended: true,
    });
  }
  return updateTaskPreviewRun({
    previewId,
    status: process.status === "terminated" ? "stopped" : "failed",
    output,
    exitCode: process.exitCode,
    errorMessage:
      process.status === "terminated" ? null : `Preview process status: ${process.status}`,
    ended: true,
  });
}

export async function stopTaskPreview(previewId: string, actorId: string) {
  const preview = await getTaskPreviewRun(previewId);
  const task = await getTask(preview.taskId);
  const project = await getProject(task.projectId);
  const role = await getProjectAccessRole(actorId, project.id);
  assertPreviewOperator({ actorId, assignedUserId: task.assignedUserId, role });
  if (!["starting", "running"].includes(preview.status)) {
    return preview;
  }
  const runner = await getTaskRunner(task.id);
  if (runner && runner.id === preview.runnerId && runner.status === "running") {
    const process = await readRunnerPreviewProcess(runner, preview.shellSessionId).catch(() => null);
    await stopRunnerPreviewProcess(runner, preview.shellSessionId);
    await updateTaskPreviewRun({
      previewId,
      status: "stopped",
      output: process?.output.slice(-50_000) ?? preview.output,
      exitCode: process?.exitCode ?? null,
      errorMessage: null,
      stoppedBy: actorId,
      ended: true,
    });
  } else {
    await updateTaskPreviewRun({
      previewId,
      status: "stopped",
      output: preview.output,
      exitCode: preview.exitCode,
      errorMessage: null,
      stoppedBy: actorId,
      ended: true,
    });
  }
  await recordAudit({
    actorId,
    projectId: project.id,
    taskId: task.id,
    eventType: "task_preview.stopped",
    payload: { previewId },
  });
  return getTaskPreviewRun(previewId);
}

export async function createAgentConnection(input: unknown, actorId: string) {
  assertOrganizationMember(await getOrganizationRole(actorId, config.organizationId));
  const data = createAgentConnectionSchema.parse(input);
  const id = randomUUID();
  const credentialRef = `openbao://secret/agent-connections/${id}`;
  await writeSecret(credentialRef, { api_key: data.apiKey });
  try {
    const connection = await insertAgentConnection({
      id,
      userId: actorId,
      provider: data.provider,
      displayName: data.displayName,
      protocol: data.protocol,
      model: data.model,
      apiBaseUrl: data.apiBaseUrl,
      maxToolRounds: data.maxToolRounds,
      launcherCommand: data.launcherCommand,
      launcherArguments: data.launcherArguments,
      credentialEnvironmentVariable: data.credentialEnvironmentVariable,
      credentialRef,
    });
    await recordAudit({
      actorId,
      eventType: "agent_connection.created",
      payload: {
        connectionId: connection.id,
        provider: connection.provider,
        protocol: connection.protocol,
        launcherCommand: connection.launcherCommand,
      },
    });
    await recordCredentialAccessEvent({
      connectionId: connection.id,
      actorId,
      eventType: "configured",
      credentialVersion: connection.credentialVersion,
      metadata: { provider: connection.provider, protocol: connection.protocol },
    });
    return connection;
  } catch (error) {
    await deleteSecret(credentialRef).catch(() => undefined);
    throw error;
  }
}

export async function configureAgentCredential(
  connectionId: string,
  input: unknown,
  actorId: string,
) {
  const data = configureAgentCredentialSchema.parse(input);
  const connection = await getAgentConnection(connectionId);
  assertCredentialOwner(actorId, connection.userId);
  const credentialRef = `openbao://secret/agent-connections/${connection.id}`;
  await writeSecret(credentialRef, { api_key: data.apiKey });
  const lifecycle = await markAgentCredentialConfigured({
    connectionId,
    credentialRef,
    model: data.model,
  });
  await recordAudit({
    actorId,
    eventType: "agent_connection.credential_configured",
    payload: { connectionId, provider: connection.provider, model: data.model ?? null },
  });
  await recordCredentialAccessEvent({
    connectionId,
    actorId,
    eventType: lifecycle.eventType,
    credentialVersion: lifecycle.credentialVersion,
    metadata: { provider: connection.provider, model: data.model ?? connection.model },
  });
  const configured = await getAgentConnection(connectionId);
  const { credentialRef: _credentialRef, ...safeConnection } = configured;
  return safeConnection;
}

export async function revokeAgentCredential(connectionId: string, actorId: string) {
  const connection = await getAgentConnection(connectionId);
  assertCredentialOwner(actorId, connection.userId);
  const credentialRef = `openbao://secret/agent-connections/${connection.id}`;
  const lifecycle = await markAgentCredentialRevoked({ connectionId, actorId });
  await deleteSecret(credentialRef);
  if (lifecycle.transitioned) {
    await recordAudit({
      actorId,
      eventType: "agent_connection.credential_revoked",
      payload: {
        connectionId,
        provider: connection.provider,
        credentialVersion: lifecycle.credentialVersion,
        cancelledSessionIds: lifecycle.cancelledSessionIds,
      },
    });
    await recordCredentialAccessEvent({
      connectionId,
      actorId,
      eventType: "revoked",
      credentialVersion: lifecycle.credentialVersion,
      metadata: { cancelledSessionIds: lifecycle.cancelledSessionIds },
    });
  }
  const revoked = await getAgentConnection(connectionId);
  const { credentialRef: _credentialRef, ...safeConnection } = revoked;
  return safeConnection;
}

async function requireRunnableTaskAgent(
  taskId: string,
  input: unknown,
  actorId: string,
) {
  const data = agentPromptSchema.parse(input);
  const task = await getTask(taskId);
  const project = await getProject(task.projectId);
  const role = await getProjectAccessRole(actorId, project.id);
  assertTaskOperator({ actorId, assignedUserId: task.assignedUserId, role });
  if (!["workspace_ready", "active", "changes_requested"].includes(task.status)) {
    throw new AppError("This task cannot run an Agent in its current state", 409, "TASK_NOT_RUNNABLE");
  }
  if (!task.agentConnectionId) {
    throw new AppError("This task has no Agent connection", 409, "AGENT_CONNECTION_MISSING");
  }
  const connection = await getAgentConnection(task.agentConnectionId);
  if (connection.userId !== task.assignedUserId) {
    throw new AppError("The task Agent does not belong to the assigned member", 409, "AGENT_OWNER_MISMATCH");
  }
  if (!connection.credentialConfigured || !connection.credentialRef) {
    throw new AppError(
      "Configure this Agent's API key before starting a session",
      409,
      "AGENT_CREDENTIAL_MISSING",
    );
  }
  if (!task.worktreePath) {
    throw new AppError("Create the task workspace first", 409, "WORKSPACE_MISSING");
  }
  const resumeSession = data.resumeSessionId
    ? await getAgentSession(data.resumeSessionId)
    : null;
  if (resumeSession) {
    if (resumeSession.taskId !== task.id) {
      throw new AppError("The resumed session belongs to another task", 409, "AGENT_SESSION_TASK_MISMATCH");
    }
    if (resumeSession.agentConnectionId !== connection.id) {
      throw new AppError("The resumed session used another Agent", 409, "AGENT_SESSION_CONNECTION_MISMATCH");
    }
    if (resumeSession.status !== "completed" || !resumeSession.providerSessionId) {
      throw new AppError("This Agent session cannot be resumed", 409, "AGENT_SESSION_NOT_RESUMABLE");
    }
  }
  return {
    data,
    task,
    connection: { ...connection, credentialRef: connection.credentialRef },
    worktreePath: task.worktreePath,
    resumeSession,
  };
}

export async function authorizeTaskAgentStart(
  taskId: string,
  input: unknown,
  actorId: string,
) {
  const { data, task, connection, resumeSession } = await requireRunnableTaskAgent(
    taskId,
    input,
    actorId,
  );
  return {
    taskId: task.id,
    connectionId: connection.id,
    prompt: data.prompt,
    resumeSessionId: resumeSession?.id,
  };
}

function managedAgentCallbacks(
  sessionId: string,
  actorId: string,
  credentialLeaseId: string,
): AgentSessionCallbacks {
  const waitForPermission = async (permissionRequestId: string) => {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      if (await isAgentSessionCancellationRequested(sessionId)) {
        return null;
      }
      const permission = await getAgentPermissionRequest(permissionRequestId);
      if (permission.status !== "pending") {
        return permission.selectedOptionId;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await resolveAgentPermissionRequest({
      permissionRequestId,
      selectedOptionId: null,
      resolvedBy: actorId,
    });
    return null;
  };

  return {
    onEvent: (event) => appendAgentEvent(sessionId, event).then(() => undefined),
    requestPermission: async (request) => {
      const permission = await insertAgentPermissionRequest({
        sessionId,
        providerRequestId: request.providerRequestId,
        toolCall: request.toolCall,
        options: request.options,
      });
      await updateAgentSession({ sessionId, status: "waiting" });
      const selectedOptionId = await waitForPermission(permission.id);
      await updateAgentSession({ sessionId, status: "running" });
      return { selectedOptionId };
    },
    shouldCancel: async () =>
      (await isAgentSessionCancellationRequested(sessionId)) ||
      !(await isAgentCredentialLeaseActive(credentialLeaseId)),
  };
}

async function executeManagedAgent(input: {
  runner: TaskRunner;
  connection: AgentConnection & { credentialRef: string };
  prompt: string;
  providerSessionId?: string | null;
  sessionId: string;
  actorId: string;
  taskId?: string | null;
  integrationId?: string | null;
}) {
  const currentConnection = await getAgentConnection(input.connection.id);
  if (!currentConnection.credentialConfigured || !currentConnection.credentialRef) {
    throw new AppError(
      "This Agent credential has been revoked or is not configured",
      409,
      "AGENT_CREDENTIAL_REVOKED",
    );
  }
  const lease = await issueAgentCredentialLease({
    connectionId: currentConnection.id,
    credentialVersion: currentConnection.credentialVersion,
    actorId: input.actorId,
    taskId: input.taskId,
    integrationId: input.integrationId,
    sessionId: input.sessionId,
    runnerId: input.runner.id,
    ttlSeconds: config.credentials.leaseTtlSeconds,
  });
  try {
    const secret = await readSecret(currentConnection.credentialRef);
    if (!(await isAgentCredentialLeaseActive(lease.id))) {
      throw new AppError(
        "The Agent credential lease became invalid before execution started",
        409,
        "AGENT_CREDENTIAL_LEASE_REVOKED",
      );
    }
    await Promise.all([
      markAgentCredentialUsed(currentConnection.id),
      recordCredentialAccessEvent({
        connectionId: currentConnection.id,
        actorId: input.actorId,
        eventType: "used",
        credentialVersion: currentConnection.credentialVersion,
        taskId: input.taskId,
        integrationId: input.integrationId,
        sessionId: input.sessionId,
        runnerId: input.runner.id,
        metadata: {
          provider: currentConnection.provider,
          protocol: currentConnection.protocol,
          credentialLeaseId: lease.id,
          leaseExpiresAt: lease.expiresAt.toISOString(),
        },
      }),
    ]);
    const callbacks = managedAgentCallbacks(input.sessionId, input.actorId, lease.id);
    let output: ParsedAgentOutput;
    if (currentConnection.protocol === "openai-compatible") {
      output = await runOpenAiCompatibleSession({
        runner: input.runner,
        connection: { ...currentConnection, credentialRef: currentConnection.credentialRef },
        apiKey: secret.api_key ?? "",
        prompt: input.prompt,
        callbacks,
      });
    } else if (currentConnection.protocol === "acp") {
      output = await runAcpSession({
        runner: input.runner,
        connection: { ...currentConnection, credentialRef: currentConnection.credentialRef },
        apiKey: secret.api_key ?? "",
        prompt: input.prompt,
        providerSessionId: input.providerSessionId,
        callbacks,
      });
    } else {
      output = await runCodexSession({
        runner: input.runner,
        apiKey: secret.api_key ?? "",
        prompt: input.prompt,
        model: currentConnection.model,
        providerSessionId: input.providerSessionId,
        callbacks,
      });
    }
    const completedLease = await refreshAgentCredentialLease(lease.id);
    if (completedLease.status === "expired") {
      throw new AppError(
        "The Agent credential lease expired during execution",
        409,
        "AGENT_CREDENTIAL_LEASE_EXPIRED",
      );
    }
    if (completedLease.status === "revoked") {
      throw new AppError(
        "The Agent credential lease was revoked during execution",
        409,
        "AGENT_CREDENTIAL_LEASE_REVOKED",
      );
    }
    return output;
  } catch (error) {
    const currentLease = await refreshAgentCredentialLease(lease.id).catch(() => null);
    if (currentLease?.status === "expired") {
      throw new AppError(
        "The Agent credential lease expired during execution",
        409,
        "AGENT_CREDENTIAL_LEASE_EXPIRED",
      );
    }
    if (currentLease?.status === "revoked") {
      throw new AppError(
        "The Agent credential lease was revoked during execution",
        409,
        "AGENT_CREDENTIAL_LEASE_REVOKED",
      );
    }
    throw error;
  } finally {
    await releaseAgentCredentialLease({
      leaseId: lease.id,
      reason: "agent_execution_finished",
    }).catch(() => undefined);
  }
}

function agentCredentialStopReason(error: unknown): string | null {
  if (!(error instanceof AppError)) return null;
  if (error.code === "AGENT_CREDENTIAL_LEASE_EXPIRED") return "credential_lease_expired";
  if (error.code === "AGENT_CREDENTIAL_LEASE_REVOKED") return "credential_lease_revoked";
  return null;
}

export async function runTaskAgent(
  taskId: string,
  input: unknown,
  actorId: string,
) {
  const { data, task, connection, worktreePath, resumeSession } = await requireRunnableTaskAgent(
    taskId,
    input,
    actorId,
  );
  const runner = await launchTaskRunner(task.id, worktreePath);
  const session = await insertAgentSession({
    taskId: task.id,
    agentConnectionId: connection.id,
    runnerId: runner.id,
    prompt: data.prompt,
    parentSessionId: resumeSession?.id,
    providerSessionId: resumeSession?.providerSessionId,
  });
  await updateAgentSession({ sessionId: session.id, status: "running" });

  const policyPrompt = [
    "You are working through BranchHarbor in an isolated task Worktree.",
    `Task: ${task.title}`,
    `Task description: ${task.description || "Not provided"}`,
    `Acceptance criteria: ${task.acceptanceCriteria || "Not provided"}`,
    "Work only inside the current workspace. Never modify or push main directly.",
    "Inspect the repository, make the requested changes, run relevant verification, and create a Git commit when the work is complete.",
    `User instruction: ${data.prompt}`,
  ].join("\n\n");

  try {
    const output = await executeManagedAgent({
      runner,
      connection,
      prompt: policyPrompt,
      providerSessionId: resumeSession?.providerSessionId,
      sessionId: session.id,
      actorId,
      taskId: task.id,
    });
    const completed = await updateAgentSession({
      sessionId: session.id,
      status: "completed",
      finalMessage: output.finalMessage ?? "Agent completed without a final text message.",
      providerSessionId: output.providerSessionId,
      stopReason: output.stopReason,
      transportMetadata: output.transportMetadata,
      ended: true,
    });
    if (task.status === "workspace_ready" || task.status === "changes_requested") {
      assertTaskTransition(task.status, "active");
      await setTaskStatus(task.id, "active");
    }
    await recordAudit({
      actorId,
      projectId: task.projectId,
      taskId: task.id,
      eventType: "agent_session.completed",
      payload: { sessionId: session.id, providerSessionId: output.providerSessionId },
    });
    return completed;
  } catch (error) {
    const cancelled = await isAgentSessionCancellationRequested(session.id).catch(() => false);
    const credentialStopReason = agentCredentialStopReason(error);
    const stopped = cancelled || credentialStopReason !== null;
    const failedSession = await updateAgentSession({
      sessionId: session.id,
      status: stopped ? "stopped" : "failed",
      errorMessage: stopped ? null : error instanceof Error ? error.message : String(error),
      stopReason: cancelled ? "cancelled" : credentialStopReason,
      ended: true,
    });
    if (stopped) {
      return failedSession;
    }
    throw error;
  }
}

export async function cancelAgentSession(sessionId: string, actorId: string) {
  const session = await getAgentSession(sessionId);
  const context = await requireAgentSessionControl(session, actorId);
  const updated = await requestAgentSessionCancellation({ sessionId, actorId });
  await recordAudit({
    actorId,
    projectId: context.project.id,
    taskId: context.task?.id,
    eventType: "agent_session.cancel_requested",
    payload: {
      sessionId,
      integrationId: session.integrationId,
      projectMergePlanRunId: session.projectMergePlanRunId,
    },
  });
  return updated;
}

async function requireAgentSessionControl(session: Awaited<ReturnType<typeof getAgentSession>>, actorId: string) {
  if (session.taskId) {
    const task = await getTask(session.taskId);
    const project = await getProject(task.projectId);
    const role = await getProjectAccessRole(actorId, project.id);
    assertTaskOperator({ actorId, assignedUserId: task.assignedUserId, role });
    return { task, project, role };
  }
  if (session.integrationId) {
    const integration = await getIntegrationRun(session.integrationId);
    const changeRequest = await getChangeRequest(integration.changeRequestId);
    const task = await getTask(changeRequest.taskId);
    const project = await getProject(task.projectId);
    const role = await getProjectAccessRole(actorId, project.id);
    assertOrganizationAdmin(role);
    return { task, project, role };
  }
  if (session.projectMergePlanRunId) {
    const mergePlanRun = await getProjectMergePlanAgentRun(session.projectMergePlanRunId);
    const project = await getProject(mergePlanRun.projectId);
    const role = await getProjectAccessRole(actorId, project.id);
    assertOrganizationAdmin(role);
    return { task: null, project, role };
  }
  throw new AppError(
    "Agent session is not attached to a task, integration, or merge plan",
    409,
    "AGENT_SESSION_ORPHANED",
  );
}

export async function resolveAgentPermission(
  permissionRequestId: string,
  input: unknown,
  actorId: string,
) {
  const data = resolveAgentPermissionSchema.parse(input);
  const permission = await getAgentPermissionRequest(permissionRequestId);
  const session = await getAgentSession(permission.sessionId);
  const context = await requireAgentSessionControl(session, actorId);
  if (permission.status !== "pending") {
    return permission;
  }
  if (
    data.selectedOptionId &&
    !permission.options.some((option) => option.optionId === data.selectedOptionId)
  ) {
    throw new AppError("Permission option is not available", 400, "INVALID_PERMISSION_OPTION");
  }
  const resolved = await resolveAgentPermissionRequest({
    permissionRequestId,
    selectedOptionId: data.selectedOptionId,
    resolvedBy: actorId,
  });
  await recordAudit({
    actorId,
    projectId: context.project.id,
    taskId: context.task?.id,
    eventType: "agent_permission.resolved",
    payload: {
      permissionRequestId,
      sessionId: session.id,
      integrationId: session.integrationId,
      projectMergePlanRunId: session.projectMergePlanRunId,
      selectedOptionId: data.selectedOptionId,
    },
  });
  return resolved;
}

export async function createProject(input: unknown, actorId: string) {
  assertOrganizationAdmin(await getOrganizationRole(actorId, config.organizationId));
  const data = createProjectSchema.parse(input);
  const id = randomUUID();
  const slug = data.slug ?? `project-${id.slice(0, 8)}`;
  const giteaRepository = await createGiteaRepository({
    name: slug,
    description: `${data.name} — managed by BranchHarbor`,
  });
  await ensureMainBranchProtection({
    owner: giteaRepository.owner.login,
    repository: giteaRepository.name,
    branch: giteaRepository.default_branch || "main",
  });
  const localRepositoryPath = path.join(config.runtimeRoot, "projects", id, "repository");
  await cloneRepository(giteaRepository.clone_url, localRepositoryPath);

  const project = await insertProject({
    id,
    name: data.name,
    slug,
    giteaOwner: giteaRepository.owner.login,
    giteaRepository: giteaRepository.name,
    repositoryUrl: giteaRepository.clone_url,
    localRepositoryPath,
    actorId,
  });
  await recordAudit({
    actorId,
    projectId: project.id,
    eventType: "project.created",
    payload: { repositoryUrl: project.repositoryUrl },
  });
  return project;
}

export async function createTask(projectId: string, input: unknown, actorId: string) {
  const project = await getProject(projectId);
  assertOrganizationMember(await getProjectAccessRole(actorId, project.id));
  const data = createTaskSchema.parse(input);
  assertOrganizationMember(
    await getProjectAccessRole(data.assignedUserId, project.id),
  );
  if (data.agentConnectionId) {
    const connection = await getAgentConnection(data.agentConnectionId);
    if (connection.userId !== data.assignedUserId) {
      throw new AppError(
        "The selected Agent must belong to the assigned user",
        409,
        "AGENT_OWNER_MISMATCH",
      );
    }
  }
  const task = await insertTask({
    projectId,
    ...data,
    actorId,
  });
  await recordAudit({
    actorId,
    projectId,
    taskId: task.id,
    eventType: "task.created",
    payload: {
      assignedUserId: task.assignedUserId,
      expectedChangeScopes: task.expectedChangeScopes,
      dependsOnTaskIds: data.dependsOnTaskIds,
    },
  });
  return task;
}

async function gitDirectoryAvailable(targetPath: string): Promise<boolean> {
  if (!(await access(targetPath).then(() => true).catch(() => false))) return false;
  return runGit(targetPath, ["rev-parse", "--git-dir"])
    .then(() => true)
    .catch(() => false);
}

async function synchronizeTaskWorkspaceDurability(input: {
  task: Task;
  project: Project;
  actorId: string | null;
}) {
  const { task, project } = input;
  if (!task.worktreePath || !task.baseCommit || !task.branchName) {
    throw new AppError(
      "Create the task workspace before synchronizing it",
      409,
      "WORKSPACE_MISSING",
    );
  }
  const worktreePath = task.worktreePath;
  const branchName = task.branchName;
  return withAdvisoryLock(`task-workspace-durability:${task.id}`, async () => {
    const [repositoryAvailable, worktreeAvailable] = await Promise.all([
      gitDirectoryAvailable(project.localRepositoryPath),
      gitDirectoryAvailable(worktreePath),
    ]);
    let restored = false;
    try {
      if (!repositoryAvailable || !worktreeAvailable) {
        const recovery = await restoreTaskWorkspaceBackup({
          repositoryPath: project.localRepositoryPath,
          repositoryUrl: project.repositoryUrl,
          worktreePath,
          taskId: task.id,
          branchName,
        });
        await rebuildTaskRunnerAfterWorkspaceRestore(task.id, worktreePath);
        await recordTaskWorkspaceBackup({
          taskId: task.id,
          projectId: project.id,
          branchName,
          remoteHeadCommit: recovery.remoteHeadCommit,
          checkpointCommit: recovery.checkpointCommit,
          workingTreeClean: recovery.workingTreeClean,
          changedFiles: recovery.changedFiles,
          status: "restored",
          restoredBy: input.actorId,
        });
        await recordAudit({
          actorId: input.actorId,
          projectId: project.id,
          taskId: task.id,
          eventType: "task.workspace_restored",
          payload: {
            branchName: task.branchName,
            remoteHeadCommit: recovery.remoteHeadCommit,
            checkpointCommit: recovery.checkpointCommit,
            checkpointRestored: recovery.checkpointRestored,
            repositoryCloned: recovery.repositoryCloned,
          },
        });
        restored = true;
      }
      const backup = await syncTaskWorkspaceBackup({
        worktreePath,
        taskId: task.id,
        branchName,
      });
      const recorded = await recordTaskWorkspaceBackup({
        taskId: task.id,
        projectId: project.id,
        ...backup,
        status: "synced",
      });
      return { backup: recorded, restored };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await recordTaskWorkspaceBackupFailure({
        taskId: task.id,
        projectId: project.id,
        branchName,
        errorMessage,
      }).catch(() => undefined);
      throw error;
    }
  });
}

export async function getTaskWorkspaceBackup(taskId: string, actorId: string) {
  await requireTaskMembership(actorId, taskId);
  return getTaskWorkspaceBackupRecord(taskId);
}

export async function getTaskWorkspaceProgress(taskId: string, actorId: string) {
  const { task, project } = await requireTaskMembership(actorId, taskId);
  if (!task.worktreePath || !task.baseCommit || !task.branchName) {
    throw new AppError(
      "Create the task workspace before reading live Git progress",
      409,
      "WORKSPACE_MISSING",
    );
  }
  await synchronizeTaskWorkspaceDurability({ task, project, actorId });
  const progress = await inspectTaskWorkspaceProgress({
    repositoryPath: project.localRepositoryPath,
    worktreePath: task.worktreePath,
    baseBranch: task.baseBranch,
    baseCommit: task.baseCommit,
  });
  await captureTaskWorkspaceSnapshot({
    projectId: project.id,
    taskId: task.id,
    taskTitle: task.title,
    observedBy: actorId,
    progress,
  });
  return progress;
}

export async function captureTaskWorkspaceProgressForMonitor(taskId: string) {
  let task;
  try {
    task = await getTask(taskId);
  } catch (error) {
    if (error instanceof AppError && error.code === "TASK_NOT_FOUND") {
      return {
        continueMonitoring: false,
        snapshotCreated: false,
        reason: "task_missing",
        errorMessage: null,
      };
    }
    throw error;
  }
  if (["merged", "rejected", "cancelled"].includes(task.status)) {
    return {
      continueMonitoring: false,
      snapshotCreated: false,
      reason: `task_${task.status}`,
      errorMessage: null,
    };
  }
  if (!task.worktreePath || !task.baseCommit || !task.branchName) {
    return {
      continueMonitoring: false,
      snapshotCreated: false,
      reason: "workspace_released",
      errorMessage: null,
    };
  }
  const project = await getProject(task.projectId);
  try {
    const durability = await synchronizeTaskWorkspaceDurability({
      task,
      project,
      actorId: null,
    });
    const progress = await inspectTaskWorkspaceProgress({
      repositoryPath: project.localRepositoryPath,
      worktreePath: task.worktreePath,
      baseBranch: task.baseBranch,
      baseCommit: task.baseCommit,
    });
    const captured = await captureTaskWorkspaceSnapshot({
      projectId: project.id,
      taskId: task.id,
      taskTitle: task.title,
      observedBy: null,
      progress,
    });
    return {
      continueMonitoring: true,
      snapshotCreated: captured.created,
      reason: durability.restored
        ? "workspace_restored"
        : captured.created
          ? "snapshot_created"
          : "state_unchanged",
      errorMessage: null,
    };
  } catch (error) {
    return {
      continueMonitoring: true,
      snapshotCreated: false,
      reason: "capture_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getTaskWorkspaceProgressHistory(taskId: string, actorId: string) {
  await requireTaskMembership(actorId, taskId);
  return listTaskWorkspaceSnapshots(taskId);
}

export async function getProjectNotifications(projectId: string, actorId: string) {
  const project = await getProject(projectId);
  assertOrganizationMember(await getProjectAccessRole(actorId, project.id));
  return listProjectNotifications(projectId, actorId);
}

async function loadProjectMergePlanEvidence(projectId: string) {
  const [tasks, dependencies, scopeConflicts, latestSnapshots] = await Promise.all([
    listTasks(projectId),
    listTaskDependencies(projectId),
    listTaskScopeConflicts(projectId),
    listLatestTaskWorkspaceSnapshots(projectId),
  ]);
  return {
    tasks,
    dependencies,
    scopeConflicts,
    latestSnapshots,
    mergePlan: buildProjectMergePlan({
      tasks,
      dependencies,
      scopeConflicts,
      latestSnapshots,
    }),
  };
}

export async function getProjectMergePlan(projectId: string, actorId: string) {
  const project = await getProject(projectId);
  assertOrganizationMember(await getProjectAccessRole(actorId, project.id));
  return (await loadProjectMergePlanEvidence(projectId)).mergePlan;
}

export async function getLatestProjectMergePlanAgentRun(projectId: string, actorId: string) {
  const project = await getProject(projectId);
  assertOrganizationMember(await getProjectAccessRole(actorId, project.id));
  return getLatestProjectMergePlanAgentRunRecord(projectId);
}

export async function getProjectIntegrationQueue(projectId: string, actorId: string) {
  const project = await getProject(projectId);
  assertOrganizationMember(await getProjectAccessRole(actorId, project.id));
  return getActiveProjectIntegrationQueue(projectId);
}

export async function replaceProjectIntegrationQueue(
  projectId: string,
  input: unknown,
  actorId: string,
) {
  const data = projectIntegrationQueueSchema.parse(input);
  const project = await getProject(projectId);
  assertOrganizationAdmin(await getProjectAccessRole(actorId, project.id));
  const [{ mergePlan }, semanticRun] = await Promise.all([
    loadProjectMergePlanEvidence(projectId),
    getLatestProjectMergePlanAgentRunRecord(projectId),
  ]);
  const orderedTaskIds = buildIntegrationQueueTaskOrder({
    source: data.source,
    selectedTaskIds: data.selectedTaskIds,
    mergePlan,
    semanticRun,
  });
  const items = await Promise.all(
    orderedTaskIds.map(async (taskId) => {
      const changeRequest = await getLatestChangeRequestForTask(taskId);
      if (!changeRequest) {
        throw new AppError(
          "Every queued task must have a Change Request",
          409,
          "INTEGRATION_QUEUE_CHANGE_REQUEST_MISSING",
        );
      }
      if (!["submitted", "approved_for_integration"].includes(changeRequest.status)) {
        throw new AppError(
          "Every queued Change Request must be submitted or approved for integration",
          409,
          "INTEGRATION_QUEUE_CHANGE_REQUEST_NOT_READY",
        );
      }
      return {
        taskId,
        changeRequestId: changeRequest.id,
        headCommit: changeRequest.headCommit,
      };
    }),
  );
  const queue = await replaceProjectIntegrationQueueRecord({
    projectId,
    source: data.source,
    sourceMergePlanRunId: data.source === "semantic" ? semanticRun?.id ?? null : null,
    createdBy: actorId,
    items,
  });
  await recordAudit({
    actorId,
    projectId,
    eventType: "project.integration_queue_replaced",
    payload: {
      queueId: queue.id,
      source: queue.source,
      sourceMergePlanRunId: queue.sourceMergePlanRunId,
      taskIds: orderedTaskIds,
    },
  });
  return queue;
}

export async function cancelProjectIntegrationQueue(
  projectId: string,
  input: unknown,
  actorId: string,
) {
  const data = cancelProjectIntegrationQueueSchema.parse(input);
  const project = await getProject(projectId);
  assertOrganizationAdmin(await getProjectAccessRole(actorId, project.id));
  const queue = await cancelProjectIntegrationQueueRecord({
    projectId,
    actorId,
    reason: data.reason,
  });
  if (!queue) {
    throw new AppError(
      "There is no active integration queue to cancel",
      404,
      "INTEGRATION_QUEUE_NOT_FOUND",
    );
  }
  await recordAudit({
    actorId,
    projectId,
    eventType: "project.integration_queue_cancelled",
    payload: { queueId: queue.id, reason: data.reason },
  });
  return queue;
}

export async function getChangeRequestIntegrationQueueGate(
  changeRequestId: string,
  actorId: string,
): Promise<IntegrationQueueGate> {
  const changeRequest = await getChangeRequest(changeRequestId);
  const task = await getTask(changeRequest.taskId);
  const project = await getProject(task.projectId);
  assertOrganizationMember(await getProjectAccessRole(actorId, project.id));
  const queue = await getActiveProjectIntegrationQueue(project.id);
  return buildIntegrationQueueGate(queue, changeRequestId);
}

export async function getProjectIntegrationQueueHistory(projectId: string, actorId: string) {
  const project = await getProject(projectId);
  assertOrganizationMember(await getProjectAccessRole(actorId, project.id));
  return listProjectIntegrationQueues(projectId);
}

export async function getProjectValidationHistory(projectId: string, actorId: string) {
  const project = await getProject(projectId);
  assertOrganizationMember(await getProjectAccessRole(actorId, project.id));
  return listProjectValidationRuns(projectId);
}

export async function queueProjectValidationRun(
  projectId: string,
  input: unknown,
  actorId: string,
) {
  const data = projectValidationRunSchema.parse(input);
  const project = await getProject(projectId);
  assertOrganizationAdmin(await getProjectAccessRole(actorId, project.id));
  const queue = await getProjectIntegrationQueueRecord(data.integrationQueueId);
  if (queue.projectId !== projectId || queue.status !== "completed") {
    throw new AppError(
      "Select a completed Integration Queue from this project",
      409,
      "PROJECT_VALIDATION_QUEUE_INVALID",
    );
  }
  const mergedItems = queue.items.filter((item) => item.changeRequestStatus === "merged");
  if (mergedItems.length === 0) {
    throw new AppError(
      "The selected Integration Queue has no merged changes to validate",
      409,
      "PROJECT_VALIDATION_NO_MERGED_CHANGES",
    );
  }
  const mergedTasks = await Promise.all(mergedItems.map((item) => getTask(item.taskId)));
  const commands = [
    ...new Set(
      [...mergedTasks.flatMap((task) => task.verificationCommands), ...data.commands]
        .map((command) => command.trim())
        .filter(Boolean),
    ),
  ];
  if (commands.length === 0) {
    throw new AppError(
      "Add at least one project-level test or build command",
      409,
      "PROJECT_VALIDATION_COMMANDS_REQUIRED",
    );
  }
  const run = await insertProjectValidationRun({
    projectId,
    integrationQueueId: queue.id,
    commands,
    actorId,
  });
  await recordAudit({
    actorId,
    projectId,
    eventType: "project.validation_queued",
    payload: {
      runId: run.id,
      integrationQueueId: queue.id,
      mergedTaskIds: mergedItems.map((item) => item.taskId),
      commands,
    },
  });
  return run;
}

export async function failProjectValidationRunLaunch(
  runId: string,
  error: unknown,
  actorId: string,
) {
  const run = await getProjectValidationRun(runId);
  const project = await getProject(run.projectId);
  assertOrganizationAdmin(await getProjectAccessRole(actorId, project.id));
  if (run.status !== "queued") return run;
  const failed = await updateProjectValidationRun({
    runId,
    status: "failed",
    errorMessage: error instanceof Error ? error.message : String(error),
  });
  await recordAudit({
    actorId,
    projectId: project.id,
    eventType: "project.validation_launch_failed",
    payload: { runId, error: failed.errorMessage },
  });
  return failed;
}

export async function runProjectValidation(runId: string, actorId: string) {
  const run = await getProjectValidationRun(runId);
  const project = await getProject(run.projectId);
  assertOrganizationAdmin(await getProjectAccessRole(actorId, project.id));
  if (run.createdBy !== actorId) {
    throw new AppError(
      "Only the Admin who queued this validation can execute it",
      403,
      "PROJECT_VALIDATION_ACTOR_MISMATCH",
    );
  }
  return withAdvisoryLock(
    `project-validation-run:${run.id}`,
    () => runProjectValidationLocked(run.id, actorId),
  );
}

async function runProjectValidationLocked(runId: string, actorId: string) {
  let run = await getProjectValidationRun(runId);
  if (["passed", "failed"].includes(run.status)) return run;
  const project = await getProject(run.projectId);
  const queue = await getProjectIntegrationQueueRecord(run.integrationQueueId);
  let worktreePath = run.worktreePath;
  let runner: TaskRunner | null = null;
  let finalStatus: "passed" | "failed" = "failed";
  let finalResults: VerificationResult[] = [];
  let finalError: string | null = null;
  try {
    if (!worktreePath || !run.mainCommit) {
      const workspace = await createProjectValidationWorktree({
        repositoryPath: project.localRepositoryPath,
        projectId: project.id,
        runId: run.id,
        baseBranch: project.defaultBranch,
      });
      worktreePath = workspace.worktreePath;
      run = await updateProjectValidationRun({
        runId: run.id,
        status: "running",
        mainCommit: workspace.mainCommit,
        worktreePath: workspace.worktreePath,
        errorMessage: null,
      });
    } else if (run.status === "queued") {
      run = await updateProjectValidationRun({
        runId: run.id,
        status: "running",
        errorMessage: null,
      });
    }

    for (const item of queue.items.filter((candidate) => candidate.changeRequestStatus === "merged")) {
      try {
        await runGit(worktreePath, ["merge-base", "--is-ancestor", item.headCommit, "HEAD"]);
      } catch {
        throw new AppError(
          `Merged task ${item.taskTitle} is not contained in the validation main Commit`,
          409,
          "PROJECT_VALIDATION_QUEUE_NOT_IN_MAIN",
        );
      }
    }

    runner = await launchProjectValidationRunner(run.id, worktreePath);
    finalResults = await runVerificationInRunner(run.commands, runner);
    const passed = finalResults.length === run.commands.length &&
      finalResults.every((result) => result.exitCode === 0);
    finalStatus = passed ? "passed" : "failed";
    finalError = passed ? null : "One or more joint validation commands failed";
  } catch (error) {
    finalStatus = "failed";
    finalError = error instanceof Error ? error.message : String(error);
  } finally {
    const existingRunner = runner ?? await getProjectValidationRunner(run.id).catch(() => null);
    if (existingRunner && existingRunner.status !== "destroyed") {
      await destroyRunner(existingRunner).catch(() => undefined);
    }
    if (worktreePath) {
      await removeProjectValidationWorktree({
        repositoryPath: project.localRepositoryPath,
        worktreePath,
      }).catch(() => undefined);
    }
  }
  const completed = await updateProjectValidationRun({
    runId: run.id,
    status: finalStatus,
    results: finalResults,
    errorMessage: finalError,
  });
  await recordAudit({
    actorId,
    projectId: project.id,
    eventType: `project.validation_${completed.status}`,
    payload: {
      runId: run.id,
      integrationQueueId: queue.id,
      mainCommit: completed.mainCommit,
      commands: completed.commands,
      exitCodes: completed.results.map((result) => result.exitCode),
      error: completed.errorMessage,
    },
  });
  return completed;
}

export async function queueProjectMergePlanAgentRun(
  projectId: string,
  input: unknown,
  actorId: string,
) {
  const data = projectMergePlanAgentSchema.parse(input);
  const project = await getProject(projectId);
  assertOrganizationAdmin(await getProjectAccessRole(actorId, project.id));
  const connection = await getAgentConnection(data.agentConnectionId);
  if (connection.userId !== actorId) {
    throw new AppError(
      "The Merge Planning Agent must belong to the current Admin",
      403,
      "MERGE_PLAN_AGENT_OWNER_MISMATCH",
    );
  }
  if (connection.status !== "ready" || !connection.credentialConfigured || !connection.credentialRef) {
    throw new AppError(
      "Configure the Admin Agent credential before semantic merge planning",
      409,
      "AGENT_CREDENTIAL_MISSING",
    );
  }
  const [{ tasks, dependencies, mergePlan }, changeRequests] = await Promise.all([
    loadProjectMergePlanEvidence(projectId),
    listLatestChangeRequestsForProject(projectId),
  ]);
  if (mergePlan.items.length === 0) {
    throw new AppError(
      "There are no active tasks to analyze",
      409,
      "MERGE_PLAN_AGENT_NO_TASKS",
    );
  }
  const analysisPrompt = buildSemanticMergePlanPrompt({
    projectName: project.name,
    instruction: data.instruction,
    baselinePlan: mergePlan,
    tasks,
    dependencies,
    changeRequests,
  });
  const run = await insertProjectMergePlanAgentRun({
    projectId,
    agentConnectionId: connection.id,
    instruction: data.instruction,
    baselinePlan: mergePlan,
    dependencies,
    analysisPrompt,
    actorId,
  });
  await recordAudit({
    actorId,
    projectId,
    eventType: "project.merge_plan_agent_queued",
    payload: {
      runId: run.id,
      agentConnectionId: connection.id,
      baselineMethod: mergePlan.method,
      taskIds: mergePlan.items.map((item) => item.taskId),
    },
  });
  return run;
}

export async function runProjectMergePlanAgent(runId: string, actorId: string) {
  const run = await getProjectMergePlanAgentRun(runId);
  if (["completed", "invalid", "failed", "cancelled"].includes(run.status)) {
    return run;
  }
  if (run.status !== "starting") {
    throw new AppError(
      "This Merge Planning Agent run is already active",
      409,
      "MERGE_PLAN_AGENT_ALREADY_RUNNING",
    );
  }
  const project = await getProject(run.projectId);
  assertOrganizationAdmin(await getProjectAccessRole(actorId, project.id));
  if (run.createdBy !== actorId) {
    throw new AppError(
      "Only the Admin who queued this analysis can execute it",
      403,
      "MERGE_PLAN_AGENT_ACTOR_MISMATCH",
    );
  }
  const connection = await getAgentConnection(run.agentConnectionId);
  if (connection.userId !== actorId || !connection.credentialConfigured || !connection.credentialRef) {
    throw new AppError(
      "The selected Admin Agent credential is unavailable",
      409,
      "AGENT_CREDENTIAL_MISSING",
    );
  }

  let worktreePath: string | null = null;
  let runner: TaskRunner | null = null;
  let session: Awaited<ReturnType<typeof insertAgentSession>> | null = null;
  try {
    const workspace = await createProjectMergePlanWorktree({
      repositoryPath: project.localRepositoryPath,
      projectId: project.id,
      runId: run.id,
      baseBranch: project.defaultBranch,
    });
    worktreePath = workspace.worktreePath;
    runner = await launchProjectMergePlanRunner(run.id, project.id, workspace.worktreePath);
    session = await insertAgentSession({
      projectMergePlanRunId: run.id,
      agentConnectionId: connection.id,
      runnerId: runner.id,
      prompt: run.instruction,
    });
    await Promise.all([
      updateAgentSession({ sessionId: session.id, status: "running" }),
      updateProjectMergePlanAgentRun({ runId: run.id, status: "running" }),
    ]);

    const output = await executeManagedAgent({
      runner,
      connection: { ...connection, credentialRef: connection.credentialRef },
      prompt: run.analysisPrompt,
      sessionId: session.id,
      actorId,
    });
    const rawResponse = output.finalMessage ?? "";
    if (await isAgentSessionCancellationRequested(session.id).catch(() => false)) {
      await updateAgentSession({
        sessionId: session.id,
        status: "stopped",
        finalMessage: rawResponse || null,
        providerSessionId: output.providerSessionId,
        stopReason: "cancelled",
        transportMetadata: {
          ...output.transportMetadata,
          workspaceMode: "read-only",
          mainCommit: workspace.mainCommit,
        },
        ended: true,
      });
      const cancelled = await updateProjectMergePlanAgentRun({
        runId: run.id,
        status: "cancelled",
        rawResponse,
        errorMessage: null,
      });
      await recordAudit({
        actorId,
        projectId: project.id,
        eventType: "project.merge_plan_agent_cancelled",
        payload: { runId: run.id, sessionId: session.id },
      });
      return cancelled;
    }
    await updateAgentSession({
      sessionId: session.id,
      status: "completed",
      finalMessage: rawResponse || "Merge Planning Agent completed without a final message.",
      providerSessionId: output.providerSessionId,
      stopReason: output.stopReason,
      transportMetadata: {
        ...output.transportMetadata,
        workspaceMode: "read-only",
        mainCommit: workspace.mainCommit,
      },
      ended: true,
    });

    try {
      const suggestion = parseSemanticMergePlanSuggestion({
        output: rawResponse,
        baselinePlan: run.baselinePlan,
        dependencies: run.dependencies,
      });
      const completed = await updateProjectMergePlanAgentRun({
        runId: run.id,
        status: "completed",
        suggestion,
        rawResponse,
        errorMessage: null,
      });
      await recordAudit({
        actorId,
        projectId: project.id,
        eventType: "project.merge_plan_agent_completed",
        payload: {
          runId: run.id,
          sessionId: session.id,
          differsFromBaseline: suggestion.differsFromBaseline,
          recommendedTaskIds: suggestion.recommendedTaskIds,
          semanticConflictCount: suggestion.semanticConflicts.length,
        },
      });
      return completed;
    } catch (error) {
      const invalid = await updateProjectMergePlanAgentRun({
        runId: run.id,
        status: "invalid",
        suggestion: null,
        rawResponse,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      await recordAudit({
        actorId,
        projectId: project.id,
        eventType: "project.merge_plan_agent_invalid",
        payload: {
          runId: run.id,
          sessionId: session.id,
          error: invalid.errorMessage,
        },
      });
      return invalid;
    }
  } catch (error) {
    const cancelled = session
      ? await isAgentSessionCancellationRequested(session.id).catch(() => false)
      : false;
    if (session) {
      await updateAgentSession({
        sessionId: session.id,
        status: cancelled ? "stopped" : "failed",
        errorMessage: cancelled ? null : error instanceof Error ? error.message : String(error),
        stopReason: cancelled ? "cancelled" : null,
        ended: true,
      }).catch(() => undefined);
    }
    const failed = await updateProjectMergePlanAgentRun({
      runId: run.id,
      status: cancelled ? "cancelled" : "failed",
      errorMessage: cancelled ? null : error instanceof Error ? error.message : String(error),
    });
    await recordAudit({
      actorId,
      projectId: project.id,
      eventType: cancelled
        ? "project.merge_plan_agent_cancelled"
        : "project.merge_plan_agent_failed",
      payload: { runId: run.id, sessionId: session?.id ?? null, error: failed.errorMessage },
    });
    if (cancelled) {
      return failed;
    }
    throw error;
  } finally {
    if (runner) {
      await destroyRunner(runner).catch(() => undefined);
    }
    if (worktreePath) {
      await removeProjectMergePlanWorktree({
        repositoryPath: project.localRepositoryPath,
        worktreePath,
      }).catch(() => undefined);
    }
  }
}

export async function markProjectNotificationsRead(
  projectId: string,
  input: unknown,
  actorId: string,
) {
  const project = await getProject(projectId);
  assertOrganizationMember(await getProjectAccessRole(actorId, project.id));
  const data = markProjectNotificationsReadSchema.parse(input);
  await markProjectNotificationRecordsRead({
    projectId,
    userId: actorId,
    notificationIds: data.notificationIds,
  });
  return listProjectNotifications(projectId, actorId);
}

export async function updateTaskDependencies(taskId: string, input: unknown, actorId: string) {
  const task = await getTask(taskId);
  const project = await getProject(task.projectId);
  assertOrganizationAdmin(await getOrganizationRole(actorId, project.organizationId));
  const data = updateTaskDependenciesSchema.parse(input);
  const mutation = await replaceTaskDependencies({
    taskId,
    dependsOnTaskIds: data.dependsOnTaskIds,
    actorId,
  });
  if (mutation.changed) {
    await recordAudit({
      actorId,
      projectId: project.id,
      taskId,
      eventType: "task.dependencies_updated",
      payload: {
        revisionId: mutation.revision?.id ?? null,
        previousDependencyIds: mutation.previousDependencies.map((dependency) => dependency.taskId),
        nextDependencyIds: mutation.nextDependencies.map((dependency) => dependency.taskId),
      },
    });
  }
  return listTaskDependenciesForTask(taskId);
}

export async function getTaskDependencyHistory(taskId: string, actorId: string) {
  await requireTaskMembership(actorId, taskId);
  return listTaskDependencyRevisions(taskId);
}

export async function recoverTaskDependency(taskId: string, input: unknown, actorId: string) {
  const task = await getTask(taskId);
  const project = await getProject(task.projectId);
  assertOrganizationAdmin(await getOrganizationRole(actorId, project.organizationId));
  const data = recoverTaskDependencySchema.parse(input);
  const mutation = await recoverFailedTaskDependencyRecord({
    taskId,
    failedDependencyTaskId: data.failedDependencyTaskId,
    replacementTaskId: data.replacementTaskId,
    reason: data.reason,
    actorId,
  });
  await recordAudit({
    actorId,
    projectId: project.id,
    taskId,
    eventType: "task.dependency_recovered",
    payload: {
      revisionId: mutation.revision?.id ?? null,
      failedDependencyTaskId: mutation.failedDependency.taskId,
      failedDependencyStatus: mutation.failedDependency.status,
      replacementTaskId: mutation.replacementDependency?.taskId ?? null,
      reason: data.reason,
      nextDependencyIds: mutation.nextDependencies.map((dependency) => dependency.taskId),
    },
  });
  return {
    dependencies: await listTaskDependenciesForTask(taskId),
    revision: mutation.revision,
  };
}

export async function addProjectMember(projectId: string, input: unknown, actorId: string) {
  const project = await getProject(projectId);
  assertOrganizationAdmin(await getOrganizationRole(actorId, project.organizationId));
  const data = projectMemberSchema.parse(input);
  assertOrganizationMember(await getOrganizationRole(data.userId, project.organizationId));
  await addProjectMembership({ projectId, userId: data.userId, addedBy: actorId });
  await recordAudit({
    actorId,
    projectId,
    eventType: "project.member_added",
    payload: { userId: data.userId },
  });
  return { projectId, userId: data.userId };
}

export async function removeProjectMember(projectId: string, userId: string, actorId: string) {
  const project = await getProject(projectId);
  assertOrganizationAdmin(await getOrganizationRole(actorId, project.organizationId));
  const targetRole = await getOrganizationRole(userId, project.organizationId);
  assertOrganizationMember(targetRole);
  if (targetRole === "admin") {
    throw new AppError(
      "Organization Admins always have project access",
      409,
      "PROJECT_ADMIN_ACCESS_IMPLICIT",
    );
  }
  const openTasks = await countOpenTasksForProjectMember(projectId, userId);
  if (openTasks > 0) {
    throw new AppError(
      "Reassign or finish this member's open tasks before removing project access",
      409,
      "PROJECT_MEMBER_HAS_OPEN_TASKS",
    );
  }
  const removed = await removeProjectMembership({ projectId, userId });
  if (!removed) {
    throw new AppError(
      "Project membership not found",
      404,
      "PROJECT_MEMBERSHIP_NOT_FOUND",
    );
  }
  await recordAudit({
    actorId,
    projectId,
    eventType: "project.member_removed",
    payload: { userId },
  });
  return { projectId, userId };
}

export async function cancelTask(taskId: string, actorId: string) {
  const task = await getTask(taskId);
  const project = await getProject(task.projectId);
  const role = await getProjectAccessRole(actorId, project.id);
  assertTaskOperator({ actorId, assignedUserId: task.assignedUserId, role });
  if (task.status !== "cancelled") {
    assertTaskTransition(task.status, "cancelled");
  }

  if (task.worktreePath && task.baseCommit && task.branchName) {
    await synchronizeTaskWorkspaceDurability({ task, project, actorId });
  }

  const cancellation = await cancelTaskState({ taskId, actorId });
  await refreshProjectIntegrationQueueStatus(project.id);
  if (cancellation.transitioned) {
    await recordAudit({
      actorId,
      projectId: project.id,
      taskId,
      eventType: "task.cancelled",
      payload: { cancelledSessionIds: cancellation.cancelledSessionIds },
    });
  }

  const runner = await getTaskRunner(taskId);
  if (runner && runner.status !== "destroyed") {
    await destroyRunner(runner);
  }
  if (task.worktreePath) {
    await removeTaskWorktree({
      repositoryPath: project.localRepositoryPath,
      worktreePath: task.worktreePath,
    });
    await clearTaskWorktree(taskId);
  }

  return {
    taskId,
    status: "cancelled" as const,
    cancelledSessionIds: cancellation.cancelledSessionIds,
  };
}

export async function provisionTaskWorkspace(taskId: string, actorId: string) {
  const task = await getTask(taskId);
  const project = await getProject(task.projectId);
  assertTaskOperator({
    actorId,
    assignedUserId: task.assignedUserId,
    role: await getProjectAccessRole(actorId, project.id),
  });
  if (
    task.status !== "draft" &&
    task.worktreePath &&
    task.baseCommit &&
    task.branchName
  ) {
    await synchronizeTaskWorkspaceDurability({ task, project, actorId });
    const runner = await getTaskRunner(task.id);
    if (runner) {
      return { task, runner };
    }
    const recreatedRunner = await launchTaskRunner(task.id, task.worktreePath);
    return { task, runner: recreatedRunner };
  }
  if (task.status !== "draft") {
    throw new AppError("Only draft tasks can create a workspace", 409, "WORKSPACE_ALREADY_CREATED");
  }
  await ensureRepositoryClone({
    repositoryUrl: project.repositoryUrl,
    repositoryPath: project.localRepositoryPath,
  });
  const workspace = await createTaskWorktree({
    repositoryPath: project.localRepositoryPath,
    projectId: project.id,
    taskId: task.id,
    title: task.title,
    baseBranch: task.baseBranch,
  });
  assertTaskTransition(task.status, "workspace_ready");
  const updated = await updateTaskWorkspace({ taskId, ...workspace });
  await synchronizeTaskWorkspaceDurability({ task: updated, project, actorId });
  const runner = await launchTaskRunner(task.id, workspace.worktreePath);
  await recordAudit({
    actorId,
    projectId: project.id,
    taskId,
    eventType: "task.workspace_created",
    payload: { ...workspace, runnerId: runner.id, runnerUrl: runner.baseUrl },
  });
  return { task: updated, runner };
}

export async function startTaskRunner(taskId: string, actorId: string) {
  const task = await getTask(taskId);
  const project = await getProject(task.projectId);
  assertTaskOperator({
    actorId,
    assignedUserId: task.assignedUserId,
    role: await getProjectAccessRole(actorId, project.id),
  });
  if (["submitted", "integrating", "merged", "rejected", "cancelled"].includes(task.status)) {
    throw new AppError("This task cannot start a development runner", 409, "TASK_NOT_RUNNABLE");
  }
  if (!task.worktreePath) {
    throw new AppError("Create the task Worktree before starting a runner", 409, "WORKSPACE_MISSING");
  }
  await synchronizeTaskWorkspaceDurability({ task, project, actorId });
  const runner = await launchTaskRunner(task.id, task.worktreePath);
  await recordAudit({
    actorId,
    projectId: task.projectId,
    taskId: task.id,
    eventType: "task.runner_started",
    payload: { runnerId: runner.id, runnerUrl: runner.baseUrl },
  });
  return runner;
}

export async function submitTaskChange(
  taskId: string,
  input: unknown,
  actorId: string,
) {
  const data = submitChangeRequestSchema.parse(input);
  const task = await getTask(taskId);
  const project = await getProject(task.projectId);
  assertTaskOperator({
    actorId,
    assignedUserId: task.assignedUserId,
    role: await getProjectAccessRole(actorId, project.id),
  });
  if (task.status === "submitted") {
    const existing = await getLatestChangeRequestForTask(task.id);
    if (existing) {
      return existing;
    }
  }
  if (!task.worktreePath || !task.baseCommit || !task.branchName) {
    throw new AppError("Create the task workspace before submitting", 409, "WORKSPACE_MISSING");
  }
  if (!["workspace_ready", "active", "changes_requested"].includes(task.status)) {
    throw new AppError("This task cannot be submitted in its current state", 409, "TASK_NOT_SUBMITTABLE");
  }
  const durability = await synchronizeTaskWorkspaceDurability({ task, project, actorId });
  const gitFacts = await inspectCommittedChanges({
    worktreePath: task.worktreePath,
    baseCommit: task.baseCommit,
  });
  if (durability.backup.remoteHeadCommit !== gitFacts.headCommit) {
    throw new AppError(
      "The submitted Commit is not durably stored on the remote task branch",
      409,
      "TASK_BRANCH_SYNC_MISMATCH",
    );
  }
  const taskRunner = await getTaskRunner(task.id);
  const verificationResults = taskRunner
    ? await runVerificationInRunner(task.verificationCommands, taskRunner)
    : await runVerificationCommands(task.verificationCommands, task.worktreePath);
  const outOfScopeFiles = findFilesOutsideTaskScopes(
    gitFacts.changedFiles.flatMap((file) =>
      [file.path, file.previousPath].filter(Boolean) as string[],
    ),
    task.expectedChangeScopes,
  );
  const scopeRisk = outOfScopeFiles.length > 0
    ? `Actual changes exceed the expected scope: ${outOfScopeFiles.slice(0, 8).join(", ")}${outOfScopeFiles.length > 8 ? `, plus ${outOfScopeFiles.length - 8} more files` : ""}`
    : null;
  const changeRequest = await insertChangeRequest({
    taskId,
    summary: data.summary,
    baseCommit: task.baseCommit,
    headCommit: gitFacts.headCommit,
    changedFiles: gitFacts.changedFiles,
    diffStat: gitFacts.diffStat,
    verificationResults,
    risks: scopeRisk ? [...data.risks, scopeRisk] : data.risks,
    actorId,
  });
  await refreshQueuedChangeRequestForTask({
    taskId,
    changeRequestId: changeRequest.id,
    headCommit: changeRequest.headCommit,
  });
  await recordAudit({
    actorId,
    projectId: task.projectId,
    taskId,
    eventType: "change_request.submitted",
    payload: {
      changeRequestId: changeRequest.id,
      headCommit: changeRequest.headCommit,
      outOfScopeFiles,
    },
  });
  return changeRequest;
}

function reviewTarget(decision: ReviewDecision) {
  switch (decision) {
    case "request_changes":
      return { changeRequestStatus: "changes_requested" as const, taskStatus: "changes_requested" as const };
    case "reject":
      return { changeRequestStatus: "rejected" as const, taskStatus: "rejected" as const };
    case "approve_integration":
      return { changeRequestStatus: "approved_for_integration" as const, taskStatus: "submitted" as const };
    case "approve_final":
      throw new AppError(
        "Final approval must use the integration finalization endpoint",
        409,
        "FINAL_APPROVAL_REQUIRES_INTEGRATION",
      );
  }
}

export async function reviewChangeRequest(
  changeRequestId: string,
  input: unknown,
  actorId: string,
) {
  const data = reviewSchema.parse(input);
  const changeRequest = await getChangeRequest(changeRequestId);
  const task = await getTask(changeRequest.taskId);
  const project = await getProject(task.projectId);
  assertOrganizationAdmin(await getOrganizationRole(actorId, project.organizationId));
  const target = reviewTarget(data.decision);
  assertChangeRequestTransition(changeRequest.status, target.changeRequestStatus);
  if (task.status !== target.taskStatus) {
    assertTaskTransition(task.status, target.taskStatus);
  }
  await recordReview({
    changeRequestId,
    reviewerId: actorId,
    decision: data.decision,
    comment: data.comment,
    nextStatus: target.changeRequestStatus,
    nextTaskStatus: target.taskStatus,
  });
  if (data.decision === "reject") {
    await refreshProjectIntegrationQueueStatus(project.id);
  }
  await recordAudit({
    actorId,
    projectId: task.projectId,
    taskId: task.id,
    eventType: `change_request.${data.decision}`,
    payload: { changeRequestId, comment: data.comment },
  });
  return getChangeRequest(changeRequestId);
}

export async function startIntegration(changeRequestId: string, actorId: string) {
  const changeRequest = await getChangeRequest(changeRequestId);
  const task = await getTask(changeRequest.taskId);
  const project = await getProject(task.projectId);
  assertOrganizationAdmin(await getOrganizationRole(actorId, project.organizationId));
  return withAdvisoryLock(
    `project-integration-queue:${project.id}`,
    () => startIntegrationLocked(changeRequestId, actorId),
  );
}

async function startIntegrationLocked(changeRequestId: string, actorId: string) {
  const changeRequest = await getChangeRequest(changeRequestId);
  const task = await getTask(changeRequest.taskId);
  const project = await getProject(task.projectId);
  assertOrganizationAdmin(await getOrganizationRole(actorId, project.organizationId));
  if (
    ["integrating", "awaiting_final_approval", "integration_failed", "merged"].includes(
      changeRequest.status,
    )
  ) {
    const existing = await getLatestIntegrationForChangeRequest(changeRequest.id);
    if (existing) {
      return existing;
    }
  }
  const queueGate = await getChangeRequestIntegrationQueueGate(changeRequestId, actorId);
  if (!queueGate.allowed) {
    throw new AppError(
      queueGate.reason ?? "This Change Request cannot start integration yet",
      409,
      queueGate.queued
        ? "INTEGRATION_QUEUE_BLOCKED"
        : "INTEGRATION_QUEUE_EXCLUDES_CHANGE",
    );
  }
  const blockingDependencies = await listBlockingTaskDependencies(task.id);
  if (blockingDependencies.length > 0) {
    throw new AppError(
      `Merge task dependencies first: ${blockingDependencies.map((dependency) => `${dependency.dependsOnTitle} (${dependency.dependsOnStatus})`).join(", ")}`,
      409,
      "TASK_DEPENDENCIES_UNRESOLVED",
    );
  }
  assertChangeRequestTransition(changeRequest.status, "integrating");
  if (!task.branchName) {
    throw new AppError("Task branch is missing", 409, "TASK_BRANCH_MISSING");
  }
  await ensureRepositoryClone({
    repositoryUrl: project.repositoryUrl,
    repositoryPath: project.localRepositoryPath,
  });
  await runGit(
    project.localRepositoryPath,
    ["fetch", "origin", `+refs/heads/${task.branchName}:refs/remotes/origin/${task.branchName}`],
    true,
  );
  const remoteTaskHead = (
    await runGit(project.localRepositoryPath, ["rev-parse", `origin/${task.branchName}`])
  ).stdout.trim();
  if (remoteTaskHead !== changeRequest.headCommit) {
    throw new AppError(
      "The reviewed Change Request Commit no longer matches the remote task branch",
      409,
      "CHANGE_REQUEST_REMOTE_HEAD_MISMATCH",
    );
  }
  const prepared = await prepareIntegrationWorktree({
    repositoryPath: project.localRepositoryPath,
    projectId: project.id,
    changeRequestId,
    taskBranch: task.branchName,
    defaultBranch: project.defaultBranch,
  });
  const integration = await insertIntegrationRun({
    changeRequestId,
    branchName: prepared.branchName,
    worktreePath: prepared.worktreePath,
    actorId,
  });
  const integrationRunner = await launchIntegrationRunner(
    integration.id,
    prepared.worktreePath,
  );
  assertTaskTransition(task.status, "integrating");
  await setTaskStatus(task.id, "integrating");

  if (prepared.conflicts.length > 0) {
    return updateIntegrationRun({
      integrationId: integration.id,
      status: "needs_agent",
      report: {
        normalMerge: "conflicted",
        conflicts: prepared.conflicts,
        runnerId: integrationRunner.id,
        runnerUrl: integrationRunner.baseUrl,
        nextAction: "Run the Admin Integration Agent in this worktree",
      },
      changeRequestStatus: "integration_failed",
    });
  }

  const verificationResults = await runVerificationInRunner(
    task.verificationCommands,
    integrationRunner,
  );
  const verificationPassed = verificationResults.every((result) => result.exitCode === 0);
  const status = verificationPassed ? "awaiting_final_approval" : "verification_failed";
  const updated = await updateIntegrationRun({
    integrationId: integration.id,
    status,
    mergeCommit: prepared.mergeCommit,
    report: {
      normalMerge: "succeeded",
      mergeCommit: prepared.mergeCommit,
      runnerId: integrationRunner.id,
      runnerUrl: integrationRunner.baseUrl,
      verificationResults,
    },
    changeRequestStatus: verificationPassed
      ? "awaiting_final_approval"
      : "integration_failed",
  });
  await recordAudit({
    actorId,
    projectId: project.id,
    taskId: task.id,
    eventType: "integration.started",
    payload: { integrationId: integration.id, status },
  });
  return updated;
}

async function requireRunnableIntegrationAgent(
  integrationId: string,
  input: unknown,
  actorId: string,
) {
  const data = integrationAgentPromptSchema.parse(input);
  const integration = await getIntegrationRun(integrationId);
  if (!["needs_agent", "verification_failed"].includes(integration.status)) {
    throw new AppError(
      "This integration does not currently need an Agent",
      409,
      "INTEGRATION_AGENT_NOT_NEEDED",
    );
  }
  const changeRequest = await getChangeRequest(integration.changeRequestId);
  const task = await getTask(changeRequest.taskId);
  const project = await getProject(task.projectId);
  assertOrganizationAdmin(await getOrganizationRole(actorId, project.organizationId));
  const connection = await getAgentConnection(data.agentConnectionId);
  if (connection.userId !== actorId) {
    throw new AppError(
      "The Integration Agent must belong to the current Admin",
      403,
      "INTEGRATION_AGENT_OWNER_MISMATCH",
    );
  }
  if (!connection.credentialConfigured || !connection.credentialRef) {
    throw new AppError(
      "Configure the Admin Agent credential before starting integration",
      409,
      "AGENT_CREDENTIAL_MISSING",
    );
  }
  const runner = await getIntegrationRunner(integration.id);
  if (!runner || runner.status !== "running") {
    throw new AppError(
      "The Integration Runner is not running",
      409,
      "INTEGRATION_RUNNER_NOT_RUNNING",
    );
  }
  const resumeSession = data.resumeSessionId
    ? await getAgentSession(data.resumeSessionId)
    : null;
  if (resumeSession) {
    if (resumeSession.integrationId !== integration.id) {
      throw new AppError(
        "The resumed session belongs to another integration",
        409,
        "AGENT_SESSION_INTEGRATION_MISMATCH",
      );
    }
    if (resumeSession.agentConnectionId !== connection.id) {
      throw new AppError(
        "The resumed session used another Agent",
        409,
        "AGENT_SESSION_CONNECTION_MISMATCH",
      );
    }
    if (resumeSession.status !== "completed" || !resumeSession.providerSessionId) {
      throw new AppError("This Agent session cannot be resumed", 409, "AGENT_SESSION_NOT_RESUMABLE");
    }
  }
  return {
    data,
    integration,
    changeRequest,
    task,
    project,
    runner,
    connection: { ...connection, credentialRef: connection.credentialRef },
    resumeSession,
  };
}

export async function authorizeIntegrationAgentStart(
  integrationId: string,
  input: unknown,
  actorId: string,
) {
  const context = await requireRunnableIntegrationAgent(integrationId, input, actorId);
  return {
    integrationId,
    agentConnectionId: context.connection.id,
    prompt: context.data.prompt,
    resumeSessionId: context.resumeSession?.id,
  };
}

export async function runIntegrationAgent(
  integrationId: string,
  input: unknown,
  actorId: string,
) {
  const context = await requireRunnableIntegrationAgent(integrationId, input, actorId);
  const session = await insertAgentSession({
    integrationId,
    agentConnectionId: context.connection.id,
    runnerId: context.runner.id,
    prompt: context.data.prompt,
    parentSessionId: context.resumeSession?.id,
    providerSessionId: context.resumeSession?.providerSessionId,
  });
  await updateAgentSession({ sessionId: session.id, status: "running" });

  const policyPrompt = [
    "You are the BranchHarbor Admin Integration Agent.",
    `Project: ${context.project.name}`,
    `Task: ${context.task.title}`,
    `Task description: ${context.task.description || "Not provided"}`,
    `Acceptance criteria: ${context.task.acceptanceCriteria || "Not provided"}`,
    `Current integration report: ${JSON.stringify(context.integration.report)}`,
    "Work only inside the current Integration Worktree.",
    "Resolve every Git conflict while preserving the intent of both main and the task branch.",
    "Inspect the surrounding code before choosing a resolution. Do not push or modify main directly.",
    "Run relevant checks, stage all resolved files, and create a Git commit when the integration is complete.",
    `Admin instruction: ${context.data.prompt}`,
  ].join("\n\n");

  try {
    const output = await executeManagedAgent({
      runner: context.runner,
      connection: context.connection,
      prompt: policyPrompt,
      providerSessionId: context.resumeSession?.providerSessionId,
      sessionId: session.id,
      actorId,
      integrationId: context.integration.id,
    });
    const completed = await updateAgentSession({
      sessionId: session.id,
      status: "completed",
      finalMessage: output.finalMessage ?? "Integration Agent completed without a final message.",
      providerSessionId: output.providerSessionId,
      stopReason: output.stopReason,
      transportMetadata: output.transportMetadata,
      ended: true,
    });
    const [unmergedResult, statusResult, headResult, containsTaskCommitResult] = await Promise.all([
      executeInRunner(context.runner, "git diff --name-only --diff-filter=U"),
      executeInRunner(context.runner, "git status --porcelain"),
      executeInRunner(context.runner, "git rev-parse HEAD"),
      executeInRunner(
        context.runner,
        `git merge-base --is-ancestor ${context.changeRequest.headCommit} HEAD`,
      ),
    ]);
    const unmergedFiles = unmergedResult.output.trim().split("\n").filter(Boolean);
    const dirtyState = statusResult.output.trim();
    const containsTaskCommit = containsTaskCommitResult.exitCode === 0;
    if (
      unmergedResult.exitCode !== 0 ||
      unmergedFiles.length > 0 ||
      dirtyState ||
      !containsTaskCommit
    ) {
      const updatedIntegration = await updateIntegrationRun({
        integrationId,
        status: "needs_agent",
        mergeCommit: null,
        report: {
          ...context.integration.report,
          integrationAgent: {
            sessionId: session.id,
            agentConnectionId: context.connection.id,
            result: "incomplete",
            unmergedFiles,
            dirtyState,
            containsTaskCommit,
          },
        },
        changeRequestStatus: "integration_failed",
      });
      return { session: completed, integration: updatedIntegration };
    }

    const mergeCommit = headResult.output.trim();
    const verificationResults = await runVerificationInRunner(
      context.task.verificationCommands,
      context.runner,
    );
    const verificationPassed = verificationResults.every((result) => result.exitCode === 0);
    const updatedIntegration = await updateIntegrationRun({
      integrationId,
      status: verificationPassed ? "awaiting_final_approval" : "verification_failed",
      mergeCommit,
      report: {
        ...context.integration.report,
        integrationAgent: {
          sessionId: session.id,
          agentConnectionId: context.connection.id,
          providerSessionId: output.providerSessionId,
          result: verificationPassed ? "resolved" : "verification_failed",
        },
        mergeCommit,
        verificationResults,
      },
      changeRequestStatus: verificationPassed
        ? "awaiting_final_approval"
        : "integration_failed",
    });
    await recordAudit({
      actorId,
      projectId: context.project.id,
      taskId: context.task.id,
      eventType: "integration_agent.completed",
      payload: {
        integrationId,
        sessionId: session.id,
        mergeCommit,
        verificationPassed,
      },
    });
    return { session: completed, integration: updatedIntegration };
  } catch (error) {
    const cancelled = await isAgentSessionCancellationRequested(session.id).catch(() => false);
    const credentialStopReason = agentCredentialStopReason(error);
    const stopped = cancelled || credentialStopReason !== null;
    const failedSession = await updateAgentSession({
      sessionId: session.id,
      status: stopped ? "stopped" : "failed",
      errorMessage: stopped ? null : error instanceof Error ? error.message : String(error),
      stopReason: cancelled ? "cancelled" : credentialStopReason,
      ended: true,
    });
    if (stopped) {
      return { session: failedSession, integration: context.integration };
    }
    await updateIntegrationRun({
      integrationId,
      status: "needs_agent",
      mergeCommit: null,
      report: {
        ...context.integration.report,
        integrationAgent: {
          sessionId: session.id,
          agentConnectionId: context.connection.id,
          result: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      },
      changeRequestStatus: "integration_failed",
    });
    throw error;
  }
}

export async function finalizeIntegration(
  integrationId: string,
  input: { comment?: string },
  actorId: string,
) {
  const integration = await getIntegrationRun(integrationId);
  if (integration.status === "merged") {
    const mainCommit = String(integration.report.finalMainCommit ?? integration.mergeCommit ?? "");
    return { integrationId, mainCommit, status: "merged" as const };
  }
  if (integration.status !== "awaiting_final_approval") {
    throw new AppError(
      "Integration is not ready for final approval",
      409,
      "INTEGRATION_NOT_READY",
    );
  }
  const changeRequest = await getChangeRequest(integration.changeRequestId);
  assertChangeRequestTransition(changeRequest.status, "merged");
  const task = await getTask(changeRequest.taskId);
  const project = await getProject(task.projectId);
  assertOrganizationAdmin(await getOrganizationRole(actorId, project.organizationId));
  const mainCommit = await finalizeIntegrationGit({
    repositoryPath: project.localRepositoryPath,
    integrationBranch: integration.branchName,
    defaultBranch: project.defaultBranch,
  });
  const report = { ...integration.report, finalMainCommit: mainCommit };
  await markMerged({
    integrationId,
    changeRequestId: changeRequest.id,
    taskId: task.id,
    reviewerId: actorId,
    comment: input.comment ?? "Final integration approved",
    report,
  });
  await refreshProjectIntegrationQueueStatus(project.id);
  const [taskRunner, integrationRunner] = await Promise.all([
    getTaskRunner(task.id),
    getIntegrationRunner(integration.id),
  ]);
  await Promise.all(
    [taskRunner, integrationRunner]
      .filter((runner) => runner && runner.status !== "destroyed")
      .map((runner) => destroyRunner(runner!)),
  );
  await recordAudit({
    actorId,
    projectId: project.id,
    taskId: task.id,
    eventType: "integration.finalized",
    payload: { integrationId, mainCommit },
  });
  return { integrationId, mainCommit, status: "merged" as const };
}
