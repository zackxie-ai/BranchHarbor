import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";

import type { AuditEvent, AuditEventPage, AuditQuery } from "./audit";
import { config } from "./config";
import type { ChangeRequestStatus, ReviewDecision, TaskStatus } from "./domain";
import { AppError } from "./errors";
import { query, withTransaction } from "./db";
import type {
  IntegrationQueueSource,
  ProjectIntegrationQueue,
  ProjectIntegrationQueueItem,
} from "./integration-queue";
import type {
  ProjectValidationRun,
  ProjectValidationRunStatus,
} from "./project-validation";
import type {
  ProjectMergePlan,
  ProjectMergePlanAgentRun,
  SemanticMergePlanSuggestion,
} from "./merge-planning";
import { findTaskScopeConflicts } from "./task-coordination";
import type {
  AgentConnection,
  AgentCredentialLease,
  AgentEvent,
  AgentPermissionRequest,
  AgentSession,
  AuthenticatedUser,
  ChangeRequest,
  CredentialAccessEvent,
  IntegrationRun,
  MembershipInvitation,
  Project,
  ProjectMember,
  ProjectNotification,
  Task,
  TaskDependency,
  TaskDependencyRevision,
  TaskDependencyRevisionEntry,
  TaskDependencyRevisionKind,
  TaskPreviewRun,
  TaskRunner,
  TaskScopeConflict,
  TaskWorkspaceProgress,
  TaskWorkspaceBackup,
  TaskWorkspaceSnapshot,
  User,
  VerificationResult,
  WorkflowExecution,
  ChangedFile,
} from "./types";

export interface UserCredentialRecord {
  user: AuthenticatedUser;
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: Date | null;
}

interface MembershipInvitationRow {
  id: string;
  organization_id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  status: MembershipInvitation["status"];
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  invited_by: string;
  invited_by_name?: string;
  created_at: Date;
}

function mapMembershipInvitation(row: MembershipInvitationRow): MembershipInvitation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    invitedBy: row.invited_by,
    invitedByName: row.invited_by_name,
    createdAt: row.created_at,
  };
}

interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  gitea_owner: string;
  gitea_repository: string;
  repository_url: string;
  default_branch: string;
  local_repository_path: string;
  created_by: string;
  created_at: Date;
  task_count?: string;
  pending_review_count?: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  verification_commands: string[];
  expected_change_scopes: string[];
  status: TaskStatus;
  base_branch: string;
  base_commit: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  assigned_user_id: string;
  agent_connection_id: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  assigned_user_name?: string;
  agent_display_name?: string | null;
}

interface ChangeRequestRow {
  id: string;
  task_id: string;
  status: ChangeRequestStatus;
  summary: string;
  base_commit: string;
  head_commit: string;
  changed_files: ChangedFile[];
  diff_stat: string;
  verification_results: VerificationResult[];
  risks: string[];
  created_by: string;
  created_at: Date;
  updated_at: Date;
  task_title?: string;
  project_id?: string;
  project_name?: string;
  branch_name?: string | null;
}

interface IntegrationRow {
  id: string;
  change_request_id: string;
  status: IntegrationRun["status"];
  branch_name: string;
  worktree_path: string;
  merge_commit: string | null;
  report: Record<string, unknown>;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface ProjectIntegrationQueueRow {
  id: string;
  project_id: string;
  status: ProjectIntegrationQueue["status"];
  source: IntegrationQueueSource;
  source_merge_plan_run_id: string | null;
  created_by: string;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  created_at: Date;
  updated_at: Date;
  cancelled_at: Date | null;
  completed_at: Date | null;
}

interface ProjectIntegrationQueueItemRow {
  position: number;
  task_id: string;
  task_title: string;
  task_status: TaskStatus;
  change_request_id: string;
  change_request_status: ChangeRequestStatus;
  head_commit: string;
}

interface TaskRunnerRow {
  id: string;
  task_id: string | null;
  integration_id: string | null;
  project_merge_plan_run_id: string | null;
  project_validation_run_id: string | null;
  provider: "aio-sandbox";
  container_name: string;
  image: string;
  status: TaskRunner["status"];
  base_url: string | null;
  host_port: number | null;
  workspace_path: string;
  container_workspace_path: string;
  credential_ref: string;
  resource_limits: Record<string, string>;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ProjectMergePlanAgentRunRow {
  id: string;
  project_id: string;
  agent_connection_id: string;
  status: ProjectMergePlanAgentRun["status"];
  instruction: string;
  baseline_plan: ProjectMergePlan;
  dependencies: TaskDependency[];
  analysis_prompt: string;
  suggestion: SemanticMergePlanSuggestion | null;
  raw_response: string | null;
  error_message: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  agent_display_name?: string | null;
  session_id?: string | null;
}

interface ProjectValidationRunRow {
  id: string;
  project_id: string;
  integration_queue_id: string;
  status: ProjectValidationRunStatus;
  commands: string[];
  results: VerificationResult[];
  main_commit: string | null;
  worktree_path: string | null;
  error_message: string | null;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

interface TaskPreviewRunRow {
  id: string;
  task_id: string;
  runner_id: string;
  command: string;
  port: number;
  status: TaskPreviewRun["status"];
  shell_session_id: string;
  preview_url: string;
  output: string;
  exit_code: number | null;
  error_message: string | null;
  started_by: string;
  stopped_by: string | null;
  started_at: Date;
  ended_at: Date | null;
  updated_at: Date;
}

interface TaskWorkspaceSnapshotRow {
  id: string;
  task_id: string;
  state_hash: string;
  base_commit: string;
  head_commit: string;
  main_commit: string;
  committed_files: ChangedFile[];
  uncommitted_files: ChangedFile[];
  main_changed_files: ChangedFile[];
  overlapping_files: string[];
  structural_conflicts: TaskWorkspaceProgress["structuralConflicts"];
  main_commits_since_base: number;
  working_tree_clean: boolean;
  observed_by: string | null;
  created_at: Date;
}

interface TaskWorkspaceBackupRow {
  task_id: string;
  project_id: string;
  branch_name: string;
  remote_head_commit: string | null;
  checkpoint_commit: string | null;
  working_tree_clean: boolean;
  changed_files: ChangedFile[];
  status: TaskWorkspaceBackup["status"];
  error_message: string | null;
  sync_attempted_at: Date;
  last_synced_at: Date | null;
  last_checkpoint_at: Date | null;
  last_restored_at: Date | null;
  restored_by: string | null;
  updated_at: Date;
}

interface ProjectNotificationRow {
  id: string;
  project_id: string;
  task_id: string | null;
  task_title: string | null;
  kind: string;
  severity: ProjectNotification["severity"];
  title: string;
  message: string;
  read_at: Date | null;
  created_at: Date;
}

interface AgentCredentialLeaseRow {
  id: string;
  agent_connection_id: string;
  credential_version: number;
  actor_id: string;
  task_id: string | null;
  integration_id: string | null;
  session_id: string | null;
  runner_id: string | null;
  status: AgentCredentialLease["status"];
  issued_at: Date;
  expires_at: Date;
  released_at: Date | null;
  release_reason: string | null;
}

interface TaskDependencyRevisionRow {
  id: string;
  project_id: string;
  task_id: string;
  actor_id: string | null;
  actor_name: string;
  change_kind: TaskDependencyRevisionKind;
  change_reason: string | null;
  previous_dependencies: TaskDependencyRevisionEntry[];
  next_dependencies: TaskDependencyRevisionEntry[];
  added_dependencies: TaskDependencyRevisionEntry[];
  removed_dependencies: TaskDependencyRevisionEntry[];
  created_at: Date;
}

interface AuditEventRow {
  id: string;
  organization_id: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  project_id: string | null;
  project_name: string | null;
  task_id: string | null;
  task_title: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    giteaOwner: row.gitea_owner,
    giteaRepository: row.gitea_repository,
    repositoryUrl: row.repository_url,
    defaultBranch: row.default_branch,
    localRepositoryPath: row.local_repository_path,
    createdBy: row.created_by,
    createdAt: row.created_at,
    taskCount: row.task_count === undefined ? undefined : Number(row.task_count),
    pendingReviewCount:
      row.pending_review_count === undefined ? undefined : Number(row.pending_review_count),
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    verificationCommands: row.verification_commands,
    expectedChangeScopes: row.expected_change_scopes,
    status: row.status,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    assignedUserId: row.assigned_user_id,
    agentConnectionId: row.agent_connection_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignedUserName: row.assigned_user_name,
    agentDisplayName: row.agent_display_name,
  };
}

function mapChangeRequest(row: ChangeRequestRow): ChangeRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    summary: row.summary,
    baseCommit: row.base_commit,
    headCommit: row.head_commit,
    changedFiles: row.changed_files,
    diffStat: row.diff_stat,
    verificationResults: row.verification_results,
    risks: row.risks,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    taskTitle: row.task_title,
    projectId: row.project_id,
    projectName: row.project_name,
    branchName: row.branch_name,
  };
}

function mapIntegration(row: IntegrationRow): IntegrationRun {
  return {
    id: row.id,
    changeRequestId: row.change_request_id,
    status: row.status,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    mergeCommit: row.merge_commit,
    report: row.report,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProjectIntegrationQueueItem(
  row: ProjectIntegrationQueueItemRow,
): ProjectIntegrationQueueItem {
  return {
    position: row.position,
    taskId: row.task_id,
    taskTitle: row.task_title,
    taskStatus: row.task_status,
    changeRequestId: row.change_request_id,
    changeRequestStatus: row.change_request_status,
    headCommit: row.head_commit,
  };
}

function mapProjectIntegrationQueue(
  row: ProjectIntegrationQueueRow,
  items: ProjectIntegrationQueueItem[],
): ProjectIntegrationQueue {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    source: row.source,
    sourceMergePlanRunId: row.source_merge_plan_run_id,
    createdBy: row.created_by,
    cancelledBy: row.cancelled_by,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at,
    completedAt: row.completed_at,
    items,
  };
}

function mapTaskRunner(row: TaskRunnerRow): TaskRunner {
  return {
    id: row.id,
    taskId: row.task_id,
    integrationId: row.integration_id,
    projectMergePlanRunId: row.project_merge_plan_run_id,
    projectValidationRunId: row.project_validation_run_id,
    provider: row.provider,
    containerName: row.container_name,
    image: row.image,
    status: row.status,
    baseUrl: row.base_url,
    hostPort: row.host_port,
    workspacePath: row.workspace_path,
    containerWorkspacePath: row.container_workspace_path,
    credentialRef: row.credential_ref,
    resourceLimits: row.resource_limits,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProjectValidationRun(row: ProjectValidationRunRow): ProjectValidationRun {
  return {
    id: row.id,
    projectId: row.project_id,
    integrationQueueId: row.integration_queue_id,
    status: row.status,
    commands: row.commands,
    results: row.results,
    mainCommit: row.main_commit,
    worktreePath: row.worktree_path,
    errorMessage: row.error_message,
    createdBy: row.created_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function mapProjectMergePlanAgentRun(
  row: ProjectMergePlanAgentRunRow,
): ProjectMergePlanAgentRun {
  return {
    id: row.id,
    projectId: row.project_id,
    agentConnectionId: row.agent_connection_id,
    agentDisplayName: row.agent_display_name,
    sessionId: row.session_id,
    status: row.status,
    instruction: row.instruction,
    baselinePlan: row.baseline_plan,
    dependencies: row.dependencies,
    analysisPrompt: row.analysis_prompt,
    suggestion: row.suggestion,
    rawResponse: row.raw_response,
    errorMessage: row.error_message,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskPreviewRun(row: TaskPreviewRunRow): TaskPreviewRun {
  return {
    id: row.id,
    taskId: row.task_id,
    runnerId: row.runner_id,
    command: row.command,
    port: row.port,
    status: row.status,
    shellSessionId: row.shell_session_id,
    previewUrl: row.preview_url,
    output: row.output,
    exitCode: row.exit_code,
    errorMessage: row.error_message,
    startedBy: row.started_by,
    stoppedBy: row.stopped_by,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskWorkspaceSnapshot(row: TaskWorkspaceSnapshotRow): TaskWorkspaceSnapshot {
  return {
    id: row.id,
    taskId: row.task_id,
    baseCommit: row.base_commit,
    headCommit: row.head_commit,
    mainCommit: row.main_commit,
    committedFiles: row.committed_files,
    uncommittedFiles: row.uncommitted_files,
    actualChangedFiles: [
      ...new Set([
        ...row.committed_files.flatMap((file) => [file.path, file.previousPath].filter(Boolean)),
        ...row.uncommitted_files.flatMap((file) => [file.path, file.previousPath].filter(Boolean)),
      ]),
    ].sort() as string[],
    mainChangedFiles: row.main_changed_files,
    overlappingFiles: row.overlapping_files,
    structuralConflicts: row.structural_conflicts,
    mainCommitsSinceBase: row.main_commits_since_base,
    mainAdvanced: row.main_commits_since_base > 0,
    workingTreeClean: row.working_tree_clean,
    checkedAt: row.created_at.toISOString(),
    observedBy: row.observed_by,
    createdAt: row.created_at.toISOString(),
  };
}

function mapTaskWorkspaceBackup(row: TaskWorkspaceBackupRow): TaskWorkspaceBackup {
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    branchName: row.branch_name,
    remoteHeadCommit: row.remote_head_commit,
    checkpointCommit: row.checkpoint_commit,
    workingTreeClean: row.working_tree_clean,
    changedFiles: row.changed_files,
    status: row.status,
    errorMessage: row.error_message,
    syncAttemptedAt: row.sync_attempted_at,
    lastSyncedAt: row.last_synced_at,
    lastCheckpointAt: row.last_checkpoint_at,
    lastRestoredAt: row.last_restored_at,
    restoredBy: row.restored_by,
    updatedAt: row.updated_at,
  };
}

function mapProjectNotification(row: ProjectNotificationRow): ProjectNotification {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    message: row.message,
    read: row.read_at !== null,
    readAt: row.read_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function mapAgentCredentialLease(row: AgentCredentialLeaseRow): AgentCredentialLease {
  return {
    id: row.id,
    agentConnectionId: row.agent_connection_id,
    credentialVersion: row.credential_version,
    actorId: row.actor_id,
    taskId: row.task_id,
    integrationId: row.integration_id,
    sessionId: row.session_id,
    runnerId: row.runner_id,
    status: row.status,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  };
}

function mapTaskDependencyRevision(row: TaskDependencyRevisionRow): TaskDependencyRevision {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    changeKind: row.change_kind,
    changeReason: row.change_reason,
    previousDependencies: row.previous_dependencies,
    nextDependencies: row.next_dependencies,
    addedDependencies: row.added_dependencies,
    removedDependencies: row.removed_dependencies,
    createdAt: row.created_at,
  };
}

function mapAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    projectId: row.project_id,
    projectName: row.project_name,
    taskId: row.task_id,
    taskTitle: row.task_title,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export async function listUsers(organizationId = config.organizationId): Promise<User[]> {
  const rows = await query<{
    id: string;
    email: string;
    name: string;
    role: "admin" | "member";
  }>(
    `SELECT u.id, u.email, u.name, m.role
       FROM users u
       JOIN memberships m ON m.user_id = u.id
      WHERE m.organization_id = $1
      ORDER BY CASE m.role WHEN 'admin' THEN 0 ELSE 1 END, u.name`,
    [organizationId],
  );
  return rows;
}

export async function listAgentConnections(
  organizationId = config.organizationId,
): Promise<AgentConnection[]> {
  const rows = await query<{
    id: string;
    user_id: string;
    provider: string;
    display_name: string;
    protocol: AgentConnection["protocol"];
    status: AgentConnection["status"];
    model: string | null;
    credential_configured: boolean;
    credential_version: number;
    credential_configured_at: Date | null;
    credential_rotated_at: Date | null;
    credential_revoked_at: Date | null;
    credential_last_used_at: Date | null;
    launcher_command: string | null;
    launcher_arguments: string[];
    credential_environment_variable: string;
    api_base_url: string | null;
    max_tool_rounds: number;
  }>(
    `SELECT a.id, a.user_id, a.provider, a.display_name, a.protocol, a.status, a.model,
            a.launcher_command, a.launcher_arguments, a.credential_environment_variable,
            a.api_base_url, a.max_tool_rounds,
            a.credential_version, a.credential_configured_at, a.credential_rotated_at,
            a.credential_revoked_at, a.credential_last_used_at,
            a.credential_ref IS NOT NULL AND a.credential_revoked_at IS NULL AS credential_configured
       FROM agent_connections a
       JOIN memberships m ON m.user_id = a.user_id
      WHERE m.organization_id = $1
      ORDER BY a.display_name`,
    [organizationId],
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    displayName: row.display_name,
    protocol: row.protocol,
    status: row.status,
    model: row.model,
    credentialConfigured: row.credential_configured,
    credentialVersion: row.credential_version,
    credentialConfiguredAt: row.credential_configured_at,
    credentialRotatedAt: row.credential_rotated_at,
    credentialRevokedAt: row.credential_revoked_at,
    credentialLastUsedAt: row.credential_last_used_at,
    launcherCommand: row.launcher_command,
    launcherArguments: row.launcher_arguments,
    credentialEnvironmentVariable: row.credential_environment_variable,
    apiBaseUrl: row.api_base_url,
    maxToolRounds: row.max_tool_rounds,
  }));
}

export async function listProjectAgentConnections(projectId: string): Promise<AgentConnection[]> {
  const rows = await query<{
    id: string;
    user_id: string;
    provider: string;
    display_name: string;
    protocol: AgentConnection["protocol"];
    status: AgentConnection["status"];
    model: string | null;
    credential_configured: boolean;
    credential_version: number;
    credential_configured_at: Date | null;
    credential_rotated_at: Date | null;
    credential_revoked_at: Date | null;
    credential_last_used_at: Date | null;
    launcher_command: string | null;
    launcher_arguments: string[];
    credential_environment_variable: string;
    api_base_url: string | null;
    max_tool_rounds: number;
  }>(
    `SELECT a.id, a.user_id, a.provider, a.display_name, a.protocol, a.status, a.model,
            a.launcher_command, a.launcher_arguments, a.credential_environment_variable,
            a.api_base_url, a.max_tool_rounds,
            a.credential_version, a.credential_configured_at, a.credential_rotated_at,
            a.credential_revoked_at, a.credential_last_used_at,
            a.credential_ref IS NOT NULL AND a.credential_revoked_at IS NULL AS credential_configured
       FROM agent_connections a
       JOIN memberships membership ON membership.user_id = a.user_id
       JOIN projects project ON project.organization_id = membership.organization_id
       LEFT JOIN project_memberships project_membership
         ON project_membership.project_id = project.id
        AND project_membership.user_id = a.user_id
      WHERE project.id = $1
        AND (membership.role = 'admin' OR project_membership.user_id IS NOT NULL)
      ORDER BY a.display_name`,
    [projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    displayName: row.display_name,
    protocol: row.protocol,
    status: row.status,
    model: row.model,
    credentialConfigured: row.credential_configured,
    credentialVersion: row.credential_version,
    credentialConfiguredAt: row.credential_configured_at,
    credentialRotatedAt: row.credential_rotated_at,
    credentialRevokedAt: row.credential_revoked_at,
    credentialLastUsedAt: row.credential_last_used_at,
    launcherCommand: row.launcher_command,
    launcherArguments: row.launcher_arguments,
    credentialEnvironmentVariable: row.credential_environment_variable,
    apiBaseUrl: row.api_base_url,
    maxToolRounds: row.max_tool_rounds,
  }));
}

export async function getAgentConnection(connectionId: string): Promise<AgentConnection & { credentialRef: string | null }> {
  const [row] = await query<{
    id: string;
    user_id: string;
    provider: string;
    display_name: string;
    protocol: AgentConnection["protocol"];
    status: AgentConnection["status"];
    model: string | null;
    credential_ref: string | null;
    credential_configured: boolean;
    credential_version: number;
    credential_configured_at: Date | null;
    credential_rotated_at: Date | null;
    credential_revoked_at: Date | null;
    credential_last_used_at: Date | null;
    launcher_command: string | null;
    launcher_arguments: string[];
    credential_environment_variable: string;
    api_base_url: string | null;
    max_tool_rounds: number;
  }>(
    `SELECT id, user_id, provider, display_name, protocol, status, model, credential_ref,
            launcher_command, launcher_arguments, credential_environment_variable,
            api_base_url, max_tool_rounds,
            credential_version, credential_configured_at, credential_rotated_at,
            credential_revoked_at, credential_last_used_at,
            credential_ref IS NOT NULL AND credential_revoked_at IS NULL AS credential_configured
       FROM agent_connections WHERE id = $1`,
    [connectionId],
  );
  if (!row) {
    throw new AppError("Agent connection not found", 404, "AGENT_CONNECTION_NOT_FOUND");
  }
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    displayName: row.display_name,
    protocol: row.protocol,
    status: row.status,
    model: row.model,
    credentialConfigured: row.credential_configured,
    credentialVersion: row.credential_version,
    credentialConfiguredAt: row.credential_configured_at,
    credentialRotatedAt: row.credential_rotated_at,
    credentialRevokedAt: row.credential_revoked_at,
    credentialLastUsedAt: row.credential_last_used_at,
    launcherCommand: row.launcher_command,
    launcherArguments: row.launcher_arguments,
    credentialEnvironmentVariable: row.credential_environment_variable,
    apiBaseUrl: row.api_base_url,
    maxToolRounds: row.max_tool_rounds,
    credentialRef: row.credential_ref,
  };
}

export async function insertAgentConnection(input: {
  id: string;
  userId: string;
  provider: string;
  displayName: string;
  protocol: "local" | "acp" | "openai-compatible";
  model?: string;
  apiBaseUrl?: string;
  maxToolRounds?: number;
  launcherCommand?: string;
  launcherArguments: string[];
  credentialEnvironmentVariable: string;
  credentialRef: string;
}): Promise<AgentConnection> {
  await query(
    `INSERT INTO agent_connections (
       id, user_id, provider, display_name, protocol, model, launcher_command,
       launcher_arguments, credential_environment_variable, api_base_url,
       max_tool_rounds, credential_ref,
       credential_configured_at, credential_version, credential_rotated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::JSONB,$9,$10,$11,$12,NOW(),1,NOW())`,
    [
      input.id,
      input.userId,
      input.provider,
      input.displayName,
      input.protocol,
      input.model ?? null,
      input.launcherCommand || null,
      JSON.stringify(input.launcherArguments),
      input.credentialEnvironmentVariable,
      input.apiBaseUrl ?? null,
      input.maxToolRounds ?? 24,
      input.credentialRef,
    ],
  );
  const { credentialRef: _credentialRef, ...connection } = await getAgentConnection(input.id);
  return connection;
}

export async function markAgentCredentialConfigured(input: {
  connectionId: string;
  credentialRef: string;
  model?: string;
}): Promise<{ credentialVersion: number; eventType: "configured" | "rotated" }> {
  const rows = await query<{ credential_version: number }>(
    `UPDATE agent_connections
        SET credential_ref = $2,
            model = COALESCE($3, model),
            credential_configured_at = NOW(),
            credential_rotated_at = NOW(),
            credential_revoked_at = NULL,
            credential_version = credential_version + 1,
            status = 'ready'
      WHERE id = $1
      RETURNING credential_version`,
    [input.connectionId, input.credentialRef, input.model ?? null],
  );
  if (rows.length === 0) {
    throw new AppError("Agent connection not found", 404, "AGENT_CONNECTION_NOT_FOUND");
  }
  const credentialVersion = rows[0]!.credential_version;
  return {
    credentialVersion,
    eventType: credentialVersion === 1 ? "configured" : "rotated",
  };
}

export async function markAgentCredentialRevoked(input: {
  connectionId: string;
  actorId: string;
}): Promise<{
  transitioned: boolean;
  credentialVersion: number;
  cancelledSessionIds: string[];
}> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      credential_ref: string | null;
      credential_revoked_at: Date | null;
      credential_version: number;
    }>(
      `SELECT credential_ref, credential_revoked_at, credential_version
         FROM agent_connections
        WHERE id = $1
        FOR UPDATE`,
      [input.connectionId],
    );
    const connection = result.rows[0];
    if (!connection) {
      throw new AppError("Agent connection not found", 404, "AGENT_CONNECTION_NOT_FOUND");
    }
    const transitioned = connection.credential_ref !== null || connection.credential_revoked_at === null;
    await client.query(
      `UPDATE agent_connections
          SET credential_ref = NULL,
              credential_revoked_at = COALESCE(credential_revoked_at, NOW()),
              status = 'disabled'
        WHERE id = $1`,
      [input.connectionId],
    );
    const sessions = await client.query<{ id: string }>(
      `UPDATE agent_sessions
          SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
              cancelled_by = COALESCE(cancelled_by, $2),
              updated_at = NOW()
        WHERE agent_connection_id = $1
          AND status IN ('starting', 'running', 'waiting')
        RETURNING id`,
      [input.connectionId, input.actorId],
    );
    await client.query(
      `UPDATE agent_permission_requests
          SET status = 'cancelled', resolved_at = NOW(), resolved_by = $2
        WHERE status = 'pending'
          AND session_id IN (
            SELECT id FROM agent_sessions WHERE agent_connection_id = $1
          )`,
      [input.connectionId, input.actorId],
    );
    await client.query(
      `UPDATE agent_credential_leases
          SET status = 'revoked',
              released_at = COALESCE(released_at, NOW()),
              release_reason = COALESCE(release_reason, 'credential_revoked')
        WHERE agent_connection_id = $1
          AND status = 'active'`,
      [input.connectionId],
    );
    return {
      transitioned,
      credentialVersion: connection.credential_version,
      cancelledSessionIds: sessions.rows.map((row) => row.id),
    };
  });
}

export async function markAgentCredentialUsed(connectionId: string): Promise<void> {
  await query(
    "UPDATE agent_connections SET credential_last_used_at = NOW() WHERE id = $1",
    [connectionId],
  );
}

export async function issueAgentCredentialLease(input: {
  connectionId: string;
  credentialVersion: number;
  actorId: string;
  taskId?: string | null;
  integrationId?: string | null;
  sessionId: string;
  runnerId: string;
  ttlSeconds: number;
}): Promise<AgentCredentialLease> {
  const id = randomUUID();
  const rows = await query<AgentCredentialLeaseRow>(
    `INSERT INTO agent_credential_leases (
       id, agent_connection_id, credential_version, actor_id, task_id,
       integration_id, session_id, runner_id, expires_at
     )
     SELECT $1, connection.id, $3, $4, $5, $6, $7, $8,
            NOW() + ($9::DOUBLE PRECISION * INTERVAL '1 second')
       FROM agent_connections connection
      WHERE connection.id = $2
        AND connection.credential_version = $3
        AND connection.credential_ref IS NOT NULL
        AND connection.credential_revoked_at IS NULL
        AND connection.status = 'ready'
     RETURNING *`,
    [
      id,
      input.connectionId,
      input.credentialVersion,
      input.actorId,
      input.taskId ?? null,
      input.integrationId ?? null,
      input.sessionId,
      input.runnerId,
      input.ttlSeconds,
    ],
  );
  if (!rows[0]) {
    throw new AppError(
      "This Agent credential cannot issue a new execution lease",
      409,
      "AGENT_CREDENTIAL_LEASE_UNAVAILABLE",
    );
  }
  return mapAgentCredentialLease(rows[0]);
}

export async function getAgentCredentialLease(leaseId: string): Promise<AgentCredentialLease> {
  const [row] = await query<AgentCredentialLeaseRow>(
    "SELECT * FROM agent_credential_leases WHERE id = $1",
    [leaseId],
  );
  if (!row) {
    throw new AppError("Agent credential lease not found", 404, "AGENT_CREDENTIAL_LEASE_NOT_FOUND");
  }
  return mapAgentCredentialLease(row);
}

export async function refreshAgentCredentialLease(
  leaseId: string,
): Promise<AgentCredentialLease> {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE agent_credential_leases lease
          SET status = CASE
                WHEN lease.expires_at <= NOW() THEN 'expired'
                ELSE 'revoked'
              END,
              released_at = COALESCE(lease.released_at, NOW()),
              release_reason = COALESCE(
                lease.release_reason,
                CASE
                  WHEN lease.expires_at <= NOW() THEN 'ttl_expired'
                  ELSE 'credential_changed'
                END
              )
         FROM agent_connections connection
        WHERE lease.id = $1
          AND lease.agent_connection_id = connection.id
          AND lease.status = 'active'
          AND (
            lease.expires_at <= NOW()
            OR connection.credential_ref IS NULL
            OR connection.credential_revoked_at IS NOT NULL
            OR connection.status <> 'ready'
            OR connection.credential_version <> lease.credential_version
          )`,
      [leaseId],
    );
    const result = await client.query<AgentCredentialLeaseRow>(
      "SELECT * FROM agent_credential_leases WHERE id = $1",
      [leaseId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        "Agent credential lease not found",
        404,
        "AGENT_CREDENTIAL_LEASE_NOT_FOUND",
      );
    }
    return mapAgentCredentialLease(row);
  });
}

export async function isAgentCredentialLeaseActive(leaseId: string): Promise<boolean> {
  return (await refreshAgentCredentialLease(leaseId)).status === "active";
}

export async function releaseAgentCredentialLease(input: {
  leaseId: string;
  reason: string;
}): Promise<AgentCredentialLease> {
  await refreshAgentCredentialLease(input.leaseId);
  const rows = await query<AgentCredentialLeaseRow>(
    `UPDATE agent_credential_leases
        SET status = 'released',
            released_at = NOW(),
            release_reason = $2
      WHERE id = $1
        AND status = 'active'
      RETURNING *`,
    [input.leaseId, input.reason],
  );
  return rows[0] ? mapAgentCredentialLease(rows[0]) : getAgentCredentialLease(input.leaseId);
}

export async function listAgentCredentialLeases(
  userId: string,
  limit = 100,
): Promise<AgentCredentialLease[]> {
  await query(
    `UPDATE agent_credential_leases lease
        SET status = CASE
              WHEN lease.expires_at <= NOW() THEN 'expired'
              ELSE 'revoked'
            END,
            released_at = COALESCE(lease.released_at, NOW()),
            release_reason = COALESCE(
              lease.release_reason,
              CASE
                WHEN lease.expires_at <= NOW() THEN 'ttl_expired'
                ELSE 'credential_changed'
              END
            )
       FROM agent_connections connection
      WHERE lease.agent_connection_id = connection.id
        AND connection.user_id = $1
        AND lease.status = 'active'
        AND (
          lease.expires_at <= NOW()
          OR connection.credential_ref IS NULL
          OR connection.credential_revoked_at IS NOT NULL
          OR connection.status <> 'ready'
          OR connection.credential_version <> lease.credential_version
        )`,
    [userId],
  );
  const rows = await query<AgentCredentialLeaseRow>(
    `SELECT lease.*
       FROM agent_credential_leases lease
       JOIN agent_connections connection ON connection.id = lease.agent_connection_id
      WHERE connection.user_id = $1
      ORDER BY lease.issued_at DESC
      LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map(mapAgentCredentialLease);
}

export async function recordCredentialAccessEvent(input: {
  connectionId: string;
  actorId: string;
  eventType: CredentialAccessEvent["eventType"];
  credentialVersion: number;
  taskId?: string | null;
  integrationId?: string | null;
  sessionId?: string | null;
  runnerId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO credential_access_events (
       id, agent_connection_id, actor_id, task_id, integration_id,
       session_id, runner_id, event_type, credential_version, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::JSONB)`,
    [
      randomUUID(),
      input.connectionId,
      input.actorId,
      input.taskId ?? null,
      input.integrationId ?? null,
      input.sessionId ?? null,
      input.runnerId ?? null,
      input.eventType,
      input.credentialVersion,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export async function listCredentialAccessEvents(
  connectionId: string,
  limit = 50,
): Promise<CredentialAccessEvent[]> {
  const rows = await query<{
    id: string;
    agent_connection_id: string;
    actor_id: string;
    task_id: string | null;
    integration_id: string | null;
    session_id: string | null;
    runner_id: string | null;
    event_type: CredentialAccessEvent["eventType"];
    credential_version: number;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT * FROM credential_access_events
      WHERE agent_connection_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [connectionId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    agentConnectionId: row.agent_connection_id,
    actorId: row.actor_id,
    taskId: row.task_id,
    integrationId: row.integration_id,
    sessionId: row.session_id,
    runnerId: row.runner_id,
    eventType: row.event_type,
    credentialVersion: row.credential_version,
    metadata: row.metadata,
    createdAt: row.created_at,
  }));
}

export async function listProjects(actorId: string): Promise<Project[]> {
  const rows = await query<ProjectRow>(
    `SELECT p.*,
            COUNT(DISTINCT t.id)::TEXT AS task_count,
            COUNT(DISTINCT cr.id) FILTER (
              WHERE cr.status IN ('submitted', 'approved_for_integration', 'awaiting_final_approval')
            )::TEXT AS pending_review_count
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.id
       LEFT JOIN change_requests cr ON cr.task_id = t.id
       JOIN memberships m
         ON m.organization_id = p.organization_id
        AND m.user_id = $1
       LEFT JOIN project_memberships pm
         ON pm.project_id = p.id
        AND pm.user_id = $1
      WHERE m.role = 'admin' OR pm.user_id IS NOT NULL
      GROUP BY p.id
      ORDER BY p.created_at DESC`,
    [actorId],
  );
  return rows.map(mapProject);
}

export async function getProject(projectId: string): Promise<Project> {
  const [row] = await query<ProjectRow>("SELECT * FROM projects WHERE id = $1", [projectId]);
  if (!row) {
    throw new AppError("Project not found", 404, "PROJECT_NOT_FOUND");
  }
  return mapProject(row);
}

export async function insertProject(input: {
  id: string;
  name: string;
  slug: string;
  giteaOwner: string;
  giteaRepository: string;
  repositoryUrl: string;
  localRepositoryPath: string;
  actorId: string;
}): Promise<Project> {
  return withTransaction(async (client) => {
    const result = await client.query<ProjectRow>(
      `INSERT INTO projects (
         id, organization_id, name, slug, gitea_owner, gitea_repository,
         repository_url, local_repository_path, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        input.id,
        config.organizationId,
        input.name,
        input.slug,
        input.giteaOwner,
        input.giteaRepository,
        input.repositoryUrl,
        input.localRepositoryPath,
        input.actorId,
      ],
    );
    await client.query(
      `INSERT INTO project_memberships (project_id, user_id, added_by)
       VALUES ($1,$2,$2)
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [input.id, input.actorId],
    );
    return mapProject(result.rows[0]!);
  });
}

export async function getProjectAccessRole(
  actorId: string,
  projectId: string,
): Promise<"admin" | "member" | null> {
  const [row] = await query<{ role: "admin" | "member"; has_membership: boolean }>(
    `SELECT membership.role,
            project_membership.user_id IS NOT NULL AS has_membership
       FROM projects project
       JOIN memberships membership
         ON membership.organization_id = project.organization_id
        AND membership.user_id = $1
       LEFT JOIN project_memberships project_membership
         ON project_membership.project_id = project.id
        AND project_membership.user_id = $1
      WHERE project.id = $2`,
    [actorId, projectId],
  );
  if (!row || (row.role !== "admin" && !row.has_membership)) {
    return null;
  }
  return row.role;
}

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const rows = await query<{
    id: string;
    email: string;
    name: string;
    role: "admin" | "member";
    explicit_membership: boolean;
    added_by: string | null;
    added_at: Date | null;
  }>(
    `SELECT user_account.id, user_account.email, user_account.name, membership.role,
            project_membership.user_id IS NOT NULL AS explicit_membership,
            project_membership.added_by,
            project_membership.created_at AS added_at
       FROM projects project
       JOIN memberships membership ON membership.organization_id = project.organization_id
       JOIN users user_account ON user_account.id = membership.user_id
       LEFT JOIN project_memberships project_membership
         ON project_membership.project_id = project.id
        AND project_membership.user_id = user_account.id
      WHERE project.id = $1
        AND (membership.role = 'admin' OR project_membership.user_id IS NOT NULL)
      ORDER BY CASE membership.role WHEN 'admin' THEN 0 ELSE 1 END, user_account.name`,
    [projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    explicitMembership: row.explicit_membership,
    addedBy: row.added_by,
    addedAt: row.added_at,
  }));
}

export async function addProjectMembership(input: {
  projectId: string;
  userId: string;
  addedBy: string;
}): Promise<void> {
  await query(
    `INSERT INTO project_memberships (project_id, user_id, added_by)
     VALUES ($1,$2,$3)
     ON CONFLICT (project_id, user_id) DO NOTHING`,
    [input.projectId, input.userId, input.addedBy],
  );
}

export async function removeProjectMembership(input: {
  projectId: string;
  userId: string;
}): Promise<boolean> {
  const rows = await query<{ user_id: string }>(
    `DELETE FROM project_memberships
      WHERE project_id = $1 AND user_id = $2
      RETURNING user_id`,
    [input.projectId, input.userId],
  );
  return rows.length > 0;
}

export async function countOpenTasksForProjectMember(
  projectId: string,
  userId: string,
): Promise<number> {
  const [row] = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count
       FROM tasks
      WHERE project_id = $1
        AND assigned_user_id = $2
        AND status NOT IN ('merged', 'rejected', 'cancelled')`,
    [projectId, userId],
  );
  return Number(row?.count ?? 0);
}

export async function listTasks(projectId: string): Promise<Task[]> {
  const rows = await query<TaskRow>(
    `SELECT t.*, u.name AS assigned_user_name, a.display_name AS agent_display_name
       FROM tasks t
       JOIN users u ON u.id = t.assigned_user_id
       LEFT JOIN agent_connections a ON a.id = t.agent_connection_id
      WHERE t.project_id = $1
      ORDER BY t.created_at DESC`,
    [projectId],
  );
  return rows.map(mapTask);
}

export async function getTask(taskId: string): Promise<Task> {
  const [row] = await query<TaskRow>(
    `SELECT t.*, u.name AS assigned_user_name, a.display_name AS agent_display_name
       FROM tasks t
       JOIN users u ON u.id = t.assigned_user_id
       LEFT JOIN agent_connections a ON a.id = t.agent_connection_id
      WHERE t.id = $1`,
    [taskId],
  );
  if (!row) {
    throw new AppError("Task not found", 404, "TASK_NOT_FOUND");
  }
  return mapTask(row);
}

export async function listTaskDependencies(projectId: string): Promise<TaskDependency[]> {
  const rows = await query<{
    task_id: string;
    depends_on_task_id: string;
    depends_on_title: string;
    depends_on_status: TaskStatus;
    created_by: string;
    created_at: Date;
  }>(
    `SELECT dependency.task_id, dependency.depends_on_task_id,
            prerequisite.title AS depends_on_title,
            prerequisite.status AS depends_on_status,
            dependency.created_by, dependency.created_at
       FROM task_dependencies dependency
       JOIN tasks task ON task.id = dependency.task_id
       JOIN tasks prerequisite ON prerequisite.id = dependency.depends_on_task_id
      WHERE task.project_id = $1
      ORDER BY dependency.created_at, prerequisite.title`,
    [projectId],
  );
  return rows.map((row) => ({
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    dependsOnTitle: row.depends_on_title,
    dependsOnStatus: row.depends_on_status,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

export async function listTaskDependenciesForTask(taskId: string): Promise<TaskDependency[]> {
  const rows = await query<{
    task_id: string;
    depends_on_task_id: string;
    depends_on_title: string;
    depends_on_status: TaskStatus;
    created_by: string;
    created_at: Date;
  }>(
    `SELECT dependency.task_id, dependency.depends_on_task_id,
            prerequisite.title AS depends_on_title,
            prerequisite.status AS depends_on_status,
            dependency.created_by, dependency.created_at
       FROM task_dependencies dependency
       JOIN tasks prerequisite ON prerequisite.id = dependency.depends_on_task_id
      WHERE dependency.task_id = $1
      ORDER BY dependency.created_at, prerequisite.title`,
    [taskId],
  );
  return rows.map((row) => ({
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    dependsOnTitle: row.depends_on_title,
    dependsOnStatus: row.depends_on_status,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

export async function listBlockingTaskDependencies(taskId: string): Promise<TaskDependency[]> {
  return (await listTaskDependenciesForTask(taskId)).filter(
    (dependency) => dependency.dependsOnStatus !== "merged",
  );
}

export async function listTaskDependencyRevisions(
  taskId: string,
  limit = 50,
): Promise<TaskDependencyRevision[]> {
  const rows = await query<TaskDependencyRevisionRow>(
    `SELECT *
      FROM task_dependency_revisions
      WHERE task_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [taskId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(mapTaskDependencyRevision);
}

async function insertTaskDependencyRevisionRecord(
  client: pg.PoolClient,
  input: {
    projectId: string;
    taskId: string;
    actorId: string;
    changeKind: TaskDependencyRevisionKind;
    changeReason: string | null;
    previousDependencies: TaskDependencyRevisionEntry[];
    nextDependencies: TaskDependencyRevisionEntry[];
    addedDependencies: TaskDependencyRevisionEntry[];
    removedDependencies: TaskDependencyRevisionEntry[];
  },
): Promise<TaskDependencyRevision> {
  const result = await client.query<TaskDependencyRevisionRow>(
    `INSERT INTO task_dependency_revisions (
       id, project_id, task_id, actor_id, actor_name, change_kind, change_reason,
       previous_dependencies, next_dependencies, added_dependencies, removed_dependencies
     )
     SELECT $1,$2,$3,$4,actor.name,$5,$6,$7::JSONB,$8::JSONB,$9::JSONB,$10::JSONB
       FROM users actor
      WHERE actor.id = $4
     RETURNING *`,
    [
      randomUUID(),
      input.projectId,
      input.taskId,
      input.actorId,
      input.changeKind,
      input.changeReason,
      JSON.stringify(input.previousDependencies),
      JSON.stringify(input.nextDependencies),
      JSON.stringify(input.addedDependencies),
      JSON.stringify(input.removedDependencies),
    ],
  );
  const revision = result.rows[0];
  if (!revision) {
    throw new AppError(
      "Task dependency revision could not be recorded",
      500,
      "TASK_DEPENDENCY_REVISION_FAILED",
    );
  }
  return mapTaskDependencyRevision(revision);
}

function taskWorkspaceProgressStateHash(progress: TaskWorkspaceProgress): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        baseCommit: progress.baseCommit,
        headCommit: progress.headCommit,
        mainCommit: progress.mainCommit,
        committedFiles: progress.committedFiles,
        uncommittedFiles: progress.uncommittedFiles,
        mainChangedFiles: progress.mainChangedFiles,
        overlappingFiles: [...progress.overlappingFiles].sort(),
        structuralConflicts: progress.structuralConflicts,
        mainCommitsSinceBase: progress.mainCommitsSinceBase,
        workingTreeClean: progress.workingTreeClean,
      }),
    )
    .digest("hex");
}

export async function captureTaskWorkspaceSnapshot(input: {
  projectId: string;
  taskId: string;
  taskTitle: string;
  observedBy: string | null;
  progress: TaskWorkspaceProgress;
}): Promise<{ snapshot: TaskWorkspaceSnapshot; created: boolean }> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `task-workspace-snapshot:${input.taskId}`,
    ]);
    const stateHash = taskWorkspaceProgressStateHash(input.progress);
    const previousResult = await client.query<TaskWorkspaceSnapshotRow>(
      `SELECT * FROM task_workspace_snapshots
        WHERE task_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.taskId],
    );
    const previous = previousResult.rows[0];
    if (previous?.state_hash === stateHash) {
      return { snapshot: mapTaskWorkspaceSnapshot(previous), created: false };
    }

    const snapshotId = randomUUID();
    const snapshotResult = await client.query<TaskWorkspaceSnapshotRow>(
      `INSERT INTO task_workspace_snapshots (
         id, project_id, task_id, state_hash, base_commit, head_commit, main_commit,
         committed_files, uncommitted_files, main_changed_files, overlapping_files,
         structural_conflicts, main_commits_since_base, working_tree_clean, observed_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::JSONB,$9::JSONB,$10::JSONB,$11::JSONB,$12::JSONB,$13,$14,$15)
       RETURNING *`,
      [
        snapshotId,
        input.projectId,
        input.taskId,
        stateHash,
        input.progress.baseCommit,
        input.progress.headCommit,
        input.progress.mainCommit,
        JSON.stringify(input.progress.committedFiles),
        JSON.stringify(input.progress.uncommittedFiles),
        JSON.stringify(input.progress.mainChangedFiles),
        JSON.stringify(input.progress.overlappingFiles),
        JSON.stringify(input.progress.structuralConflicts),
        input.progress.mainCommitsSinceBase,
        input.progress.workingTreeClean,
        input.observedBy,
      ],
    );
    const snapshot = snapshotResult.rows[0]!;
    const notifications: Array<{
      kind: string;
      severity: ProjectNotification["severity"];
      title: string;
      message: string;
      dedupeKey: string;
    }> = [];
    const overlapChanged =
      input.progress.overlappingFiles.length > 0 &&
      JSON.stringify([...input.progress.overlappingFiles].sort()) !==
        JSON.stringify([...(previous?.overlapping_files ?? [])].sort());
    if (overlapChanged) {
      notifications.push({
        kind: "workspace_overlap",
        severity: "danger",
        title: "Task and main have actual file overlap",
        message: `${input.taskTitle} and latest main both changed: ${input.progress.overlappingFiles.join(", ")}`,
        dedupeKey: `workspace-overlap:${input.taskId}:${input.progress.mainCommit}:${input.progress.headCommit}:${createHash("sha256").update([...input.progress.overlappingFiles].sort().join("\n")).digest("hex")}`,
      });
    }
    const structuralConflictsChanged =
      input.progress.structuralConflicts.length > 0 &&
      JSON.stringify(input.progress.structuralConflicts) !==
        JSON.stringify(previous?.structural_conflicts ?? []);
    if (structuralConflictsChanged) {
      const dangerCount = input.progress.structuralConflicts.filter(
        (conflict) => conflict.severity === "danger",
      ).length;
      notifications.push({
        kind: "workspace_structural_conflict",
        severity: dangerCount > 0 ? "danger" : "warning",
        title: "Task and main have structural relationship risks",
        message: `${input.taskTitle} has ${input.progress.structuralConflicts.length} structural relationships: ${input.progress.structuralConflicts.slice(0, 3).map((conflict) => conflict.message).join("; ")}`,
        dedupeKey: `workspace-structural:${input.taskId}:${input.progress.mainCommit}:${input.progress.headCommit}:${createHash("sha256").update(JSON.stringify(input.progress.structuralConflicts)).digest("hex")}`,
      });
    }
    if (
      !overlapChanged &&
      !structuralConflictsChanged &&
      input.progress.mainAdvanced &&
      previous?.main_commit !== input.progress.mainCommit
    ) {
      notifications.push({
        kind: "main_advanced",
        severity: "warning",
        title: "main advanced after task creation",
        message: `${input.taskTitle} is ${input.progress.mainCommitsSinceBase} Commits behind main, with no actual file overlap currently detected.`,
        dedupeKey: `workspace-main:${input.taskId}:${input.progress.mainCommit}`,
      });
    }
    if (
      input.progress.committedFiles.length > 0 &&
      previous?.head_commit !== input.progress.headCommit
    ) {
      notifications.push({
        kind: "task_commit_observed",
        severity: "info",
        title: "Task created a new Git Commit",
        message: `${input.taskTitle} has changed ${input.progress.committedFiles.length} committed files in total.`,
        dedupeKey: `workspace-commit:${input.taskId}:${input.progress.headCommit}`,
      });
    }
    for (const notification of notifications) {
      await client.query(
        `INSERT INTO project_notifications (
           id, project_id, task_id, source_snapshot_id, kind, severity,
           title, message, dedupe_key
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (project_id, dedupe_key) DO NOTHING`,
        [
          randomUUID(),
          input.projectId,
          input.taskId,
          snapshotId,
          notification.kind,
          notification.severity,
          notification.title,
          notification.message,
          notification.dedupeKey,
        ],
      );
    }
    return { snapshot: mapTaskWorkspaceSnapshot(snapshot), created: true };
  });
}

export async function listTaskWorkspaceSnapshots(
  taskId: string,
  limit = 20,
): Promise<TaskWorkspaceSnapshot[]> {
  const rows = await query<TaskWorkspaceSnapshotRow>(
    `SELECT * FROM task_workspace_snapshots
      WHERE task_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [taskId, Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map(mapTaskWorkspaceSnapshot);
}

export async function getTaskWorkspaceBackup(taskId: string): Promise<TaskWorkspaceBackup | null> {
  const [row] = await query<TaskWorkspaceBackupRow>(
    "SELECT * FROM task_workspace_backups WHERE task_id = $1",
    [taskId],
  );
  return row ? mapTaskWorkspaceBackup(row) : null;
}

export async function recordTaskWorkspaceBackup(input: {
  taskId: string;
  projectId: string;
  branchName: string;
  remoteHeadCommit: string;
  checkpointCommit: string | null;
  workingTreeClean: boolean;
  changedFiles: ChangedFile[];
  status: "synced" | "restored";
  restoredBy?: string | null;
}): Promise<TaskWorkspaceBackup> {
  const [row] = await query<TaskWorkspaceBackupRow>(
    `INSERT INTO task_workspace_backups (
       task_id, project_id, branch_name, remote_head_commit, checkpoint_commit,
       working_tree_clean, changed_files, status, error_message, sync_attempted_at,
       last_synced_at, last_checkpoint_at, last_restored_at, restored_by, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7::JSONB,$8,NULL,NOW(),
       CASE WHEN $8 = 'synced' THEN NOW() ELSE NULL END,
       CASE WHEN $5::TEXT IS NOT NULL THEN NOW() ELSE NULL END,
       CASE WHEN $8 = 'restored' THEN NOW() ELSE NULL END,$9,NOW()
     )
     ON CONFLICT (task_id) DO UPDATE SET
       project_id = EXCLUDED.project_id,
       branch_name = EXCLUDED.branch_name,
       remote_head_commit = EXCLUDED.remote_head_commit,
       checkpoint_commit = EXCLUDED.checkpoint_commit,
       working_tree_clean = EXCLUDED.working_tree_clean,
       changed_files = EXCLUDED.changed_files,
       status = EXCLUDED.status,
       error_message = NULL,
       sync_attempted_at = NOW(),
       last_synced_at = CASE WHEN EXCLUDED.status = 'synced' THEN NOW() ELSE task_workspace_backups.last_synced_at END,
       last_checkpoint_at = CASE WHEN EXCLUDED.checkpoint_commit IS NOT NULL THEN NOW() ELSE task_workspace_backups.last_checkpoint_at END,
       last_restored_at = CASE WHEN EXCLUDED.status = 'restored' THEN NOW() ELSE task_workspace_backups.last_restored_at END,
       restored_by = CASE WHEN EXCLUDED.status = 'restored' THEN EXCLUDED.restored_by ELSE task_workspace_backups.restored_by END,
       updated_at = NOW()
     RETURNING *`,
    [
      input.taskId,
      input.projectId,
      input.branchName,
      input.remoteHeadCommit,
      input.checkpointCommit,
      input.workingTreeClean,
      JSON.stringify(input.changedFiles),
      input.status,
      input.restoredBy ?? null,
    ],
  );
  return mapTaskWorkspaceBackup(row!);
}

export async function recordTaskWorkspaceBackupFailure(input: {
  taskId: string;
  projectId: string;
  branchName: string;
  errorMessage: string;
}): Promise<TaskWorkspaceBackup> {
  const [row] = await query<TaskWorkspaceBackupRow>(
    `INSERT INTO task_workspace_backups (
       task_id, project_id, branch_name, status, error_message, sync_attempted_at, updated_at
     ) VALUES ($1,$2,$3,'failed',$4,NOW(),NOW())
     ON CONFLICT (task_id) DO UPDATE SET
       status = 'failed', error_message = EXCLUDED.error_message,
       sync_attempted_at = NOW(), updated_at = NOW()
     RETURNING *`,
    [input.taskId, input.projectId, input.branchName, input.errorMessage],
  );
  return mapTaskWorkspaceBackup(row!);
}

export async function listLatestTaskWorkspaceSnapshots(
  projectId: string,
): Promise<TaskWorkspaceSnapshot[]> {
  const rows = await query<TaskWorkspaceSnapshotRow>(
    `SELECT DISTINCT ON (task_id) *
       FROM task_workspace_snapshots
      WHERE project_id = $1
      ORDER BY task_id, created_at DESC`,
    [projectId],
  );
  return rows.map(mapTaskWorkspaceSnapshot);
}

export async function listProjectNotifications(
  projectId: string,
  userId: string,
  limit = 20,
): Promise<ProjectNotification[]> {
  const rows = await query<ProjectNotificationRow>(
    `SELECT notification.*, task.title AS task_title, notification_read.read_at
       FROM project_notifications notification
       LEFT JOIN tasks task ON task.id = notification.task_id
       LEFT JOIN project_notification_reads notification_read
         ON notification_read.notification_id = notification.id
        AND notification_read.user_id = $2
      WHERE notification.project_id = $1
      ORDER BY notification.created_at DESC
      LIMIT $3`,
    [projectId, userId, Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map(mapProjectNotification);
}

export async function markProjectNotificationRecordsRead(input: {
  projectId: string;
  userId: string;
  notificationIds: string[];
}): Promise<void> {
  await withTransaction(async (client) => {
    const notificationIds = [...new Set(input.notificationIds)];
    if (notificationIds.length > 0) {
      const notificationResult = await client.query<{ id: string }>(
        `SELECT id
           FROM project_notifications
          WHERE project_id = $1
            AND id = ANY($2::uuid[])`,
        [input.projectId, notificationIds],
      );
      if (notificationResult.rowCount !== notificationIds.length) {
        throw new AppError(
          "One or more project notifications are invalid",
          400,
          "PROJECT_NOTIFICATION_INVALID",
        );
      }
    }

    await client.query(
      `INSERT INTO project_notification_reads (notification_id, user_id)
       SELECT notification.id, $2
         FROM project_notifications notification
        WHERE notification.project_id = $1
          AND ($3::uuid[] = '{}'::uuid[] OR notification.id = ANY($3::uuid[]))
       ON CONFLICT (notification_id, user_id) DO NOTHING`,
      [input.projectId, input.userId, notificationIds],
    );
  });
}

async function insertDependencyFailureNotifications(
  client: pg.PoolClient,
  failedTaskId: string,
): Promise<number> {
  const dependents = await client.query<{
    project_id: string;
    dependent_task_id: string;
    dependent_title: string;
    failed_title: string;
    failed_status: "rejected" | "cancelled";
  }>(
    `SELECT failed.project_id,
            dependent.id AS dependent_task_id,
            dependent.title AS dependent_title,
            failed.title AS failed_title,
            failed.status AS failed_status
       FROM tasks failed
       JOIN task_dependencies dependency
         ON dependency.depends_on_task_id = failed.id
      JOIN tasks dependent ON dependent.id = dependency.task_id
      WHERE failed.id = $1
        AND failed.status IN ('rejected', 'cancelled')
        AND dependent.status NOT IN ('merged', 'rejected', 'cancelled')`,
    [failedTaskId],
  );
  let created = 0;
  for (const dependent of dependents.rows) {
    const result = await client.query(
      `INSERT INTO project_notifications (
         id, project_id, task_id, kind, severity, title, message, dedupe_key
       ) VALUES ($1,$2,$3,'dependency_failed','danger',$4,$5,$6)
       ON CONFLICT (project_id, dedupe_key) DO NOTHING`,
      [
        randomUUID(),
        dependent.project_id,
        dependent.dependent_task_id,
        "Task dependency is no longer valid",
        `${dependent.dependent_title} depends on ${dependent.failed_title}, which was ${dependent.failed_status === "rejected" ? "rejected" : "cancelled"}. An Admin must remove or replace the dependency.`,
        `dependency-failed:${dependent.dependent_task_id}:${failedTaskId}:${dependent.failed_status}`,
      ],
    );
    created += result.rowCount ?? 0;
  }
  return created;
}

interface TaskDependencyMutationResult {
  changed: boolean;
  revision: TaskDependencyRevision | null;
  previousDependencies: TaskDependencyRevisionEntry[];
  nextDependencies: TaskDependencyRevisionEntry[];
}

async function mutateTaskDependencies(
  client: pg.PoolClient,
  input: {
    taskId: string;
    actorId: string;
    changeKind: TaskDependencyRevisionKind;
    changeReason: string | null;
    resolveDependencyIds: (
      previousDependencies: TaskDependencyRevisionEntry[],
    ) => string[];
    validateNextDependencies?: (
      nextDependencies: TaskDependencyRevisionEntry[],
    ) => void;
  },
): Promise<TaskDependencyMutationResult> {
  const taskResult = await client.query<{ project_id: string; status: TaskStatus }>(
    "SELECT project_id, status FROM tasks WHERE id = $1 FOR UPDATE",
    [input.taskId],
  );
  const task = taskResult.rows[0];
  if (!task) {
    throw new AppError("Task not found", 404, "TASK_NOT_FOUND");
  }
  if (["integrating", "merged", "rejected", "cancelled"].includes(task.status)) {
    throw new AppError(
      "Task dependencies cannot change after integration starts or the task ends",
      409,
      "TASK_DEPENDENCIES_LOCKED",
    );
  }
  const previousResult = await client.query<{
    task_id: string;
    title: string;
    status: TaskStatus;
  }>(
    `SELECT prerequisite.id AS task_id, prerequisite.title, prerequisite.status
       FROM task_dependencies dependency
       JOIN tasks prerequisite ON prerequisite.id = dependency.depends_on_task_id
      WHERE dependency.task_id = $1
      ORDER BY prerequisite.id`,
    [input.taskId],
  );
  const previousDependencies = previousResult.rows.map((dependency) => ({
    taskId: dependency.task_id,
    title: dependency.title,
    status: dependency.status,
  }));
  const dependencyIds = [
    ...new Set(input.resolveDependencyIds(previousDependencies)),
  ].sort();
  if (dependencyIds.includes(input.taskId)) {
    throw new AppError(
      "A task cannot depend on itself",
      409,
      "TASK_DEPENDENCY_SELF_REFERENCE",
    );
  }
  let nextDependencies: TaskDependencyRevisionEntry[] = [];
  if (dependencyIds.length > 0) {
    const targets = await client.query<{ id: string; title: string; status: TaskStatus }>(
      `SELECT id, title, status FROM tasks
        WHERE project_id = $1 AND id = ANY($2::UUID[])
        ORDER BY id
        FOR SHARE`,
      [task.project_id, dependencyIds],
    );
    if (targets.rows.length !== dependencyIds.length) {
      throw new AppError(
        "Every task dependency must belong to the same project",
        409,
        "TASK_DEPENDENCY_INVALID",
      );
    }
    nextDependencies = targets.rows.map((dependency) => ({
      taskId: dependency.id,
      title: dependency.title,
      status: dependency.status,
    }));
  }
  input.validateNextDependencies?.(nextDependencies);
  const previousIds = new Set(previousDependencies.map((dependency) => dependency.taskId));
  const nextIds = new Set(nextDependencies.map((dependency) => dependency.taskId));
  const newlyAddedFailedDependencies = nextDependencies.filter(
    (dependency) =>
      !previousIds.has(dependency.taskId) &&
      ["rejected", "cancelled"].includes(dependency.status),
  );
  if (newlyAddedFailedDependencies.length > 0) {
    throw new AppError(
      "Rejected or cancelled tasks cannot be added as dependencies",
      409,
      "TASK_DEPENDENCY_FAILED",
    );
  }
  if (input.changeKind === "manual_update") {
    const removedFailedDependencies = previousDependencies.filter(
      (dependency) =>
        ["rejected", "cancelled"].includes(dependency.status) &&
        !nextIds.has(dependency.taskId),
    );
    if (removedFailedDependencies.length > 0) {
      throw new AppError(
        "Use dependency failure recovery and provide a reason before removing a failed dependency",
        409,
        "TASK_DEPENDENCY_RECOVERY_REQUIRED",
      );
    }
  }
  if (
    previousDependencies.length === nextDependencies.length &&
    previousDependencies.every(
      (dependency, index) => dependency.taskId === nextDependencies[index]?.taskId,
    )
  ) {
    return {
      changed: false,
      revision: null,
      previousDependencies,
      nextDependencies,
    };
  }
  await client.query("DELETE FROM task_dependencies WHERE task_id = $1", [input.taskId]);
  if (dependencyIds.length > 0) {
    await client.query(
      `INSERT INTO task_dependencies (task_id, depends_on_task_id, created_by)
       SELECT $1, dependency_id, $3
         FROM UNNEST($2::UUID[]) AS dependency_id`,
      [input.taskId, dependencyIds, input.actorId],
    );
  }
  const cycle = await client.query(
    `WITH RECURSIVE dependency_chain(depends_on_task_id) AS (
       SELECT depends_on_task_id
         FROM task_dependencies
        WHERE task_id = $1
       UNION
       SELECT dependency.depends_on_task_id
         FROM task_dependencies dependency
         JOIN dependency_chain chain
           ON dependency.task_id = chain.depends_on_task_id
     )
     SELECT 1 FROM dependency_chain WHERE depends_on_task_id = $1 LIMIT 1`,
    [input.taskId],
  );
  if (cycle.rowCount) {
    throw new AppError(
      "Task dependencies cannot contain a cycle",
      409,
      "TASK_DEPENDENCY_CYCLE",
    );
  }
  const addedDependencies = nextDependencies.filter(
    (dependency) => !previousIds.has(dependency.taskId),
  );
  const removedDependencies = previousDependencies.filter(
    (dependency) => !nextIds.has(dependency.taskId),
  );
  const revision = await insertTaskDependencyRevisionRecord(client, {
    projectId: task.project_id,
    taskId: input.taskId,
    actorId: input.actorId,
    changeKind: input.changeKind,
    changeReason: input.changeReason,
    previousDependencies,
    nextDependencies,
    addedDependencies,
    removedDependencies,
  });
  return {
    changed: true,
    revision,
    previousDependencies,
    nextDependencies,
  };
}

export async function replaceTaskDependencies(input: {
  taskId: string;
  dependsOnTaskIds: string[];
  actorId: string;
}): Promise<TaskDependencyMutationResult> {
  return withTransaction((client) =>
    mutateTaskDependencies(client, {
      taskId: input.taskId,
      actorId: input.actorId,
      changeKind: "manual_update",
      changeReason: null,
      resolveDependencyIds: () => input.dependsOnTaskIds,
    }),
  );
}

export async function recoverFailedTaskDependencyRecord(input: {
  taskId: string;
  failedDependencyTaskId: string;
  replacementTaskId: string | null;
  reason: string;
  actorId: string;
}): Promise<
  TaskDependencyMutationResult & {
    failedDependency: TaskDependencyRevisionEntry;
    replacementDependency: TaskDependencyRevisionEntry | null;
  }
> {
  return withTransaction(async (client) => {
    let failedDependency: TaskDependencyRevisionEntry | undefined;
    const mutation = await mutateTaskDependencies(client, {
      taskId: input.taskId,
      actorId: input.actorId,
      changeKind: "failure_recovery",
      changeReason: input.reason,
      resolveDependencyIds: (previousDependencies) => {
        failedDependency = previousDependencies.find(
          (dependency) => dependency.taskId === input.failedDependencyTaskId,
        );
        if (!failedDependency) {
          throw new AppError(
            "The failed dependency is no longer attached to this task",
            409,
            "TASK_DEPENDENCY_RECOVERY_STALE",
          );
        }
        if (!["rejected", "cancelled"].includes(failedDependency.status)) {
          throw new AppError(
            "Only rejected or cancelled dependencies can use failure recovery",
            409,
            "TASK_DEPENDENCY_NOT_FAILED",
          );
        }
        if (input.replacementTaskId === input.failedDependencyTaskId) {
          throw new AppError(
            "The failed dependency cannot replace itself",
            409,
            "TASK_DEPENDENCY_RECOVERY_INVALID",
          );
        }
        return [
          ...previousDependencies
            .filter((dependency) => dependency.taskId !== input.failedDependencyTaskId)
            .map((dependency) => dependency.taskId),
          ...(input.replacementTaskId ? [input.replacementTaskId] : []),
        ];
      },
      validateNextDependencies: (nextDependencies) => {
        if (!input.replacementTaskId) return;
        const replacement = nextDependencies.find(
          (dependency) => dependency.taskId === input.replacementTaskId,
        );
        if (replacement && ["rejected", "cancelled"].includes(replacement.status)) {
          throw new AppError(
            "A rejected or cancelled task cannot be used as a recovery replacement",
            409,
            "TASK_DEPENDENCY_REPLACEMENT_FAILED",
          );
        }
      },
    });
    if (!failedDependency || !mutation.changed || !mutation.revision) {
      throw new AppError(
        "Task dependency recovery produced no change",
        409,
        "TASK_DEPENDENCY_RECOVERY_STALE",
      );
    }
    return {
      ...mutation,
      failedDependency,
      replacementDependency: input.replacementTaskId
        ? mutation.nextDependencies.find(
            (dependency) => dependency.taskId === input.replacementTaskId,
          ) ?? null
        : null,
    };
  });
}

export async function listTaskScopeConflicts(projectId: string): Promise<TaskScopeConflict[]> {
  return findTaskScopeConflicts(await listTasks(projectId));
}

export async function insertTask(input: {
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  verificationCommands: string[];
  expectedChangeScopes?: string[];
  dependsOnTaskIds?: string[];
  assignedUserId: string;
  agentConnectionId?: string | null;
  actorId: string;
}): Promise<Task> {
  return withTransaction(async (client) => {
    const taskId = randomUUID();
    const dependencyIds = [...new Set(input.dependsOnTaskIds ?? [])].sort();
    let dependencyEntries: TaskDependencyRevisionEntry[] = [];
    if (dependencyIds.length > 0) {
      const dependencies = await client.query<{ id: string; title: string; status: TaskStatus }>(
        `SELECT id, title, status FROM tasks
          WHERE project_id = $1 AND id = ANY($2::UUID[])
          ORDER BY id
          FOR SHARE`,
        [input.projectId, dependencyIds],
      );
      if (dependencies.rows.length !== dependencyIds.length) {
        throw new AppError(
          "Every task dependency must belong to the same project",
          409,
          "TASK_DEPENDENCY_INVALID",
        );
      }
      dependencyEntries = dependencies.rows.map((dependency) => ({
        taskId: dependency.id,
        title: dependency.title,
        status: dependency.status,
      }));
      if (
        dependencyEntries.some((dependency) =>
          ["rejected", "cancelled"].includes(dependency.status),
        )
      ) {
        throw new AppError(
          "Rejected or cancelled tasks cannot be added as dependencies",
          409,
          "TASK_DEPENDENCY_FAILED",
        );
      }
    }
    const result = await client.query<TaskRow>(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance_criteria, verification_commands,
         expected_change_scopes, assigned_user_id, agent_connection_id, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6::JSONB,$7::JSONB,$8,$9,$10)
       RETURNING *`,
      [
        taskId,
        input.projectId,
        input.title,
        input.description,
        input.acceptanceCriteria,
        JSON.stringify(input.verificationCommands),
        JSON.stringify(input.expectedChangeScopes ?? []),
        input.assignedUserId,
        input.agentConnectionId ?? null,
        input.actorId,
      ],
    );
    if (dependencyIds.length > 0) {
      await client.query(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id, created_by)
         SELECT $1, dependency_id, $3
           FROM UNNEST($2::UUID[]) AS dependency_id`,
        [taskId, dependencyIds, input.actorId],
      );
      await insertTaskDependencyRevisionRecord(client, {
        projectId: input.projectId,
        taskId,
        actorId: input.actorId,
        changeKind: "task_created",
        changeReason: null,
        previousDependencies: [],
        nextDependencies: dependencyEntries,
        addedDependencies: dependencyEntries,
        removedDependencies: [],
      });
    }
    return mapTask(result.rows[0]!);
  });
}

export async function updateTaskWorkspace(input: {
  taskId: string;
  baseCommit: string;
  branchName: string;
  worktreePath: string;
}): Promise<Task> {
  const [row] = await query<TaskRow>(
    `UPDATE tasks
        SET base_commit = $2,
            branch_name = $3,
            worktree_path = $4,
            status = 'workspace_ready',
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [input.taskId, input.baseCommit, input.branchName, input.worktreePath],
  );
  if (!row) {
    throw new AppError("Task not found", 404, "TASK_NOT_FOUND");
  }
  return mapTask(row);
}

export async function setTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
  await query("UPDATE tasks SET status = $2, updated_at = NOW() WHERE id = $1", [taskId, status]);
}

export async function cancelTaskState(input: {
  taskId: string;
  actorId: string;
}): Promise<{ transitioned: boolean; cancelledSessionIds: string[] }> {
  return withTransaction(async (client) => {
    const taskResult = await client.query<{ status: TaskStatus }>(
      "SELECT status FROM tasks WHERE id = $1 FOR UPDATE",
      [input.taskId],
    );
    const task = taskResult.rows[0];
    if (!task) {
      throw new AppError("Task not found", 404, "TASK_NOT_FOUND");
    }
    const transitioned = task.status !== "cancelled";
    if (transitioned && !["draft", "workspace_ready", "active", "changes_requested"].includes(task.status)) {
      throw new AppError(
        `Task cannot move from ${task.status} to cancelled`,
        409,
        "INVALID_TASK_TRANSITION",
      );
    }

    if (transitioned) {
      await client.query(
        "UPDATE tasks SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
        [input.taskId],
      );
      await client.query(
        `UPDATE change_requests
            SET status = 'cancelled', updated_at = NOW()
          WHERE task_id = $1
            AND status IN ('changes_requested')`,
        [input.taskId],
      );
      await insertDependencyFailureNotifications(client, input.taskId);
    }
    const sessions = await client.query<{ id: string }>(
      `UPDATE agent_sessions
          SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
              cancelled_by = COALESCE(cancelled_by, $2),
              updated_at = NOW()
        WHERE task_id = $1 AND status IN ('starting', 'running', 'waiting')
        RETURNING id`,
      [input.taskId, input.actorId],
    );
    await client.query(
      `UPDATE agent_permission_requests
          SET status = 'cancelled',
              resolved_at = NOW(),
              resolved_by = $2
        WHERE status = 'pending'
          AND session_id IN (SELECT id FROM agent_sessions WHERE task_id = $1)`,
      [input.taskId, input.actorId],
    );
    return { transitioned, cancelledSessionIds: sessions.rows.map((row) => row.id) };
  });
}

export async function clearTaskWorktree(taskId: string): Promise<void> {
  await query(
    "UPDATE tasks SET worktree_path = NULL, updated_at = NOW() WHERE id = $1",
    [taskId],
  );
}

export async function insertTaskRunner(input: {
  id: string;
  taskId: string;
  containerName: string;
  image: string;
  workspacePath: string;
  containerWorkspacePath: string;
  credentialRef: string;
  resourceLimits: Record<string, string>;
}): Promise<TaskRunner> {
  const [row] = await query<TaskRunnerRow>(
    `INSERT INTO task_runners (
       id, task_id, container_name, image, status, workspace_path,
       container_workspace_path, credential_ref, resource_limits
     ) VALUES ($1,$2,$3,$4,'starting',$5,$6,$7,$8::JSONB)
     RETURNING *`,
    [
      input.id,
      input.taskId,
      input.containerName,
      input.image,
      input.workspacePath,
      input.containerWorkspacePath,
      input.credentialRef,
      JSON.stringify(input.resourceLimits),
    ],
  );
  return mapTaskRunner(row!);
}

export async function insertIntegrationRunner(input: {
  id: string;
  integrationId: string;
  containerName: string;
  image: string;
  workspacePath: string;
  containerWorkspacePath: string;
  credentialRef: string;
  resourceLimits: Record<string, string>;
}): Promise<TaskRunner> {
  const [row] = await query<TaskRunnerRow>(
    `INSERT INTO task_runners (
       id, integration_id, container_name, image, status, workspace_path,
       container_workspace_path, credential_ref, resource_limits
     ) VALUES ($1,$2,$3,$4,'starting',$5,$6,$7,$8::JSONB)
     RETURNING *`,
    [
      input.id,
      input.integrationId,
      input.containerName,
      input.image,
      input.workspacePath,
      input.containerWorkspacePath,
      input.credentialRef,
      JSON.stringify(input.resourceLimits),
    ],
  );
  return mapTaskRunner(row!);
}

export async function insertProjectMergePlanRunner(input: {
  id: string;
  projectMergePlanRunId: string;
  containerName: string;
  image: string;
  workspacePath: string;
  containerWorkspacePath: string;
  credentialRef: string;
  resourceLimits: Record<string, string>;
}): Promise<TaskRunner> {
  const [row] = await query<TaskRunnerRow>(
    `INSERT INTO task_runners (
       id, project_merge_plan_run_id, container_name, image, status, workspace_path,
       container_workspace_path, credential_ref, resource_limits
     ) VALUES ($1,$2,$3,$4,'starting',$5,$6,$7,$8::JSONB)
     RETURNING *`,
    [
      input.id,
      input.projectMergePlanRunId,
      input.containerName,
      input.image,
      input.workspacePath,
      input.containerWorkspacePath,
      input.credentialRef,
      JSON.stringify(input.resourceLimits),
    ],
  );
  return mapTaskRunner(row!);
}

export async function insertProjectValidationRunner(input: {
  id: string;
  projectValidationRunId: string;
  containerName: string;
  image: string;
  workspacePath: string;
  containerWorkspacePath: string;
  credentialRef: string;
  resourceLimits: Record<string, string>;
}): Promise<TaskRunner> {
  const [row] = await query<TaskRunnerRow>(
    `INSERT INTO task_runners (
       id, project_validation_run_id, container_name, image, status, workspace_path,
       container_workspace_path, credential_ref, resource_limits
     ) VALUES ($1,$2,$3,$4,'starting',$5,$6,$7,$8::JSONB)
     RETURNING *`,
    [
      input.id,
      input.projectValidationRunId,
      input.containerName,
      input.image,
      input.workspacePath,
      input.containerWorkspacePath,
      input.credentialRef,
      JSON.stringify(input.resourceLimits),
    ],
  );
  return mapTaskRunner(row!);
}

export async function updateTaskRunner(input: {
  runnerId: string;
  status: TaskRunner["status"];
  baseUrl?: string | null;
  hostPort?: number | null;
  lastError?: string | null;
}): Promise<TaskRunner> {
  const [row] = await query<TaskRunnerRow>(
    `UPDATE task_runners
        SET status = $2,
            base_url = COALESCE($3, base_url),
            host_port = COALESCE($4, host_port),
            last_error = $5,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      input.runnerId,
      input.status,
      input.baseUrl ?? null,
      input.hostPort ?? null,
      input.lastError ?? null,
    ],
  );
  if (!row) {
    throw new AppError("Task runner not found", 404, "RUNNER_NOT_FOUND");
  }
  return mapTaskRunner(row);
}

export async function getTaskRunner(taskId: string): Promise<TaskRunner | null> {
  const [row] = await query<TaskRunnerRow>("SELECT * FROM task_runners WHERE task_id = $1", [taskId]);
  return row ? mapTaskRunner(row) : null;
}

export async function getRunner(runnerId: string): Promise<TaskRunner> {
  const [row] = await query<TaskRunnerRow>("SELECT * FROM task_runners WHERE id = $1", [runnerId]);
  if (!row) {
    throw new AppError("Task runner not found", 404, "RUNNER_NOT_FOUND");
  }
  return mapTaskRunner(row);
}

export async function getIntegrationRunner(integrationId: string): Promise<TaskRunner | null> {
  const [row] = await query<TaskRunnerRow>(
    "SELECT * FROM task_runners WHERE integration_id = $1",
    [integrationId],
  );
  return row ? mapTaskRunner(row) : null;
}

export async function getProjectMergePlanRunner(
  projectMergePlanRunId: string,
): Promise<TaskRunner | null> {
  const [row] = await query<TaskRunnerRow>(
    "SELECT * FROM task_runners WHERE project_merge_plan_run_id = $1",
    [projectMergePlanRunId],
  );
  return row ? mapTaskRunner(row) : null;
}

export async function getProjectValidationRunner(
  projectValidationRunId: string,
): Promise<TaskRunner | null> {
  const [row] = await query<TaskRunnerRow>(
    "SELECT * FROM task_runners WHERE project_validation_run_id = $1",
    [projectValidationRunId],
  );
  return row ? mapTaskRunner(row) : null;
}

export async function insertTaskPreviewRun(input: {
  id: string;
  taskId: string;
  runnerId: string;
  command: string;
  port: number;
  shellSessionId: string;
  previewUrl: string;
  startedBy: string;
}): Promise<TaskPreviewRun> {
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [input.taskId]);
    const active = await client.query(
      `SELECT id
         FROM task_preview_runs
        WHERE task_id = $1
          AND status IN ('starting', 'running')`,
      [input.taskId],
    );
    if (active.rowCount) {
      throw new AppError(
        "This task already has an active preview",
        409,
        "TASK_PREVIEW_ALREADY_RUNNING",
      );
    }
    const result = await client.query<TaskPreviewRunRow>(
      `INSERT INTO task_preview_runs (
         id, task_id, runner_id, command, port, status,
         shell_session_id, preview_url, started_by
       ) VALUES ($1,$2,$3,$4,$5,'starting',$6,$7,$8)
       RETURNING *`,
      [
        input.id,
        input.taskId,
        input.runnerId,
        input.command,
        input.port,
        input.shellSessionId,
        input.previewUrl,
        input.startedBy,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError("Failed to create preview record", 500, "TASK_PREVIEW_CREATE_FAILED");
    }
    return mapTaskPreviewRun(row);
  });
}

export async function getTaskPreviewRun(previewId: string): Promise<TaskPreviewRun> {
  const [row] = await query<TaskPreviewRunRow>(
    `SELECT * FROM task_preview_runs WHERE id = $1`,
    [previewId],
  );
  if (!row) {
    throw new AppError("Task preview not found", 404, "TASK_PREVIEW_NOT_FOUND");
  }
  return mapTaskPreviewRun(row);
}

export async function getLatestTaskPreviewRun(taskId: string): Promise<TaskPreviewRun | null> {
  const [row] = await query<TaskPreviewRunRow>(
    `SELECT *
       FROM task_preview_runs
      WHERE task_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [taskId],
  );
  return row ? mapTaskPreviewRun(row) : null;
}

export async function listTaskPreviewRuns(
  taskId: string,
  limit = 10,
): Promise<TaskPreviewRun[]> {
  const rows = await query<TaskPreviewRunRow>(
    `SELECT *
       FROM task_preview_runs
      WHERE task_id = $1
      ORDER BY started_at DESC
      LIMIT $2`,
    [taskId, limit],
  );
  return rows.map(mapTaskPreviewRun);
}

export async function updateTaskPreviewRun(input: {
  previewId: string;
  status: TaskPreviewRun["status"];
  output?: string;
  exitCode?: number | null;
  errorMessage?: string | null;
  stoppedBy?: string | null;
  ended?: boolean;
}): Promise<TaskPreviewRun> {
  const [row] = await query<TaskPreviewRunRow>(
    `UPDATE task_preview_runs
        SET status = $2,
            output = COALESCE($3, output),
            exit_code = $4,
            error_message = $5,
            stopped_by = COALESCE($6, stopped_by),
            ended_at = CASE WHEN $7 THEN COALESCE(ended_at, NOW()) ELSE ended_at END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      input.previewId,
      input.status,
      input.output ?? null,
      input.exitCode ?? null,
      input.errorMessage ?? null,
      input.stoppedBy ?? null,
      input.ended ?? false,
    ],
  );
  if (!row) {
    throw new AppError("Task preview not found", 404, "TASK_PREVIEW_NOT_FOUND");
  }
  return mapTaskPreviewRun(row);
}

export async function stopActiveTaskPreviewsForRunner(
  runnerId: string,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE task_preview_runs
        SET status = 'stopped',
            error_message = COALESCE(error_message, $2),
            ended_at = COALESCE(ended_at, NOW()),
            updated_at = NOW()
      WHERE runner_id = $1
        AND status IN ('starting', 'running')`,
    [runnerId, reason],
  );
}

interface AgentSessionRow {
  id: string;
  task_id: string | null;
  integration_id: string | null;
  project_merge_plan_run_id: string | null;
  agent_connection_id: string | null;
  runner_id: string | null;
  status: AgentSession["status"];
  prompt: string;
  final_message: string | null;
  error_message: string | null;
  provider_session_id: string | null;
  parent_session_id: string | null;
  stop_reason: string | null;
  transport_metadata: Record<string, unknown>;
  cancel_requested_at: Date | null;
  cancelled_by: string | null;
  started_at: Date;
  ended_at: Date | null;
  updated_at: Date;
  agent_display_name?: string | null;
}

function mapAgentSession(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    taskId: row.task_id,
    integrationId: row.integration_id,
    projectMergePlanRunId: row.project_merge_plan_run_id,
    agentConnectionId: row.agent_connection_id,
    runnerId: row.runner_id,
    status: row.status,
    prompt: row.prompt,
    finalMessage: row.final_message,
    errorMessage: row.error_message,
    providerSessionId: row.provider_session_id,
    parentSessionId: row.parent_session_id,
    stopReason: row.stop_reason,
    transportMetadata: row.transport_metadata,
    cancelRequestedAt: row.cancel_requested_at,
    cancelledBy: row.cancelled_by,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
    agentDisplayName: row.agent_display_name,
  };
}

export async function insertAgentSession(input: {
  taskId?: string | null;
  integrationId?: string | null;
  projectMergePlanRunId?: string | null;
  agentConnectionId: string;
  runnerId: string;
  prompt: string;
  parentSessionId?: string | null;
  providerSessionId?: string | null;
}): Promise<AgentSession> {
  const [row] = await query<AgentSessionRow>(
    `INSERT INTO agent_sessions (
       id, task_id, integration_id, project_merge_plan_run_id, agent_connection_id,
       runner_id, status, prompt, parent_session_id, provider_session_id
     ) VALUES ($1,$2,$3,$4,$5,$6,'starting',$7,$8,$9)
     RETURNING *`,
    [
      randomUUID(),
      input.taskId ?? null,
      input.integrationId ?? null,
      input.projectMergePlanRunId ?? null,
      input.agentConnectionId,
      input.runnerId,
      input.prompt,
      input.parentSessionId ?? null,
      input.providerSessionId ?? null,
    ],
  );
  return mapAgentSession(row!);
}

export async function updateAgentSession(input: {
  sessionId: string;
  status: AgentSession["status"];
  finalMessage?: string | null;
  errorMessage?: string | null;
  providerSessionId?: string | null;
  stopReason?: string | null;
  transportMetadata?: Record<string, unknown>;
  ended?: boolean;
}): Promise<AgentSession> {
  const [row] = await query<AgentSessionRow>(
    `UPDATE agent_sessions
        SET status = $2,
            final_message = COALESCE($3, final_message),
            error_message = $4,
            provider_session_id = COALESCE($5, provider_session_id),
            stop_reason = COALESCE($6, stop_reason),
            transport_metadata = transport_metadata || $7::JSONB,
            ended_at = CASE WHEN $8 THEN NOW() ELSE ended_at END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      input.sessionId,
      input.status,
      input.finalMessage ?? null,
      input.errorMessage ?? null,
      input.providerSessionId ?? null,
      input.stopReason ?? null,
      JSON.stringify(input.transportMetadata ?? {}),
      input.ended ?? false,
    ],
  );
  if (!row) {
    throw new AppError("Agent session not found", 404, "AGENT_SESSION_NOT_FOUND");
  }
  return mapAgentSession(row);
}

export async function getAgentSession(sessionId: string): Promise<AgentSession> {
  const [row] = await query<AgentSessionRow>(
    `SELECT s.*, a.display_name AS agent_display_name
       FROM agent_sessions s
       LEFT JOIN agent_connections a ON a.id = s.agent_connection_id
      WHERE s.id = $1`,
    [sessionId],
  );
  if (!row) {
    throw new AppError("Agent session not found", 404, "AGENT_SESSION_NOT_FOUND");
  }
  return mapAgentSession(row);
}

export async function requestAgentSessionCancellation(input: {
  sessionId: string;
  actorId: string;
}): Promise<AgentSession> {
  const [row] = await query<AgentSessionRow>(
    `UPDATE agent_sessions
        SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
            cancelled_by = COALESCE(cancelled_by, $2),
            updated_at = NOW()
      WHERE id = $1 AND status IN ('starting', 'running', 'waiting')
      RETURNING *`,
    [input.sessionId, input.actorId],
  );
  if (!row) {
    return getAgentSession(input.sessionId);
  }
  return mapAgentSession(row);
}

export async function isAgentSessionCancellationRequested(sessionId: string): Promise<boolean> {
  const [row] = await query<{ requested: boolean }>(
    `SELECT cancel_requested_at IS NOT NULL AS requested
       FROM agent_sessions
      WHERE id = $1`,
    [sessionId],
  );
  if (!row) {
    throw new AppError("Agent session not found", 404, "AGENT_SESSION_NOT_FOUND");
  }
  return row.requested;
}

export async function appendAgentEvent(
  sessionId: string,
  event: { eventType: string; payload: Record<string, unknown> },
): Promise<AgentEvent> {
  return withTransaction(async (client) => {
    const sequence = await client.query<{ sequence_number: number }>(
      `UPDATE agent_sessions
          SET next_event_sequence = next_event_sequence + 1,
              updated_at = NOW()
        WHERE id = $1
        RETURNING next_event_sequence - 1 AS sequence_number`,
      [sessionId],
    );
    if (!sequence.rows[0]) {
      throw new AppError("Agent session not found", 404, "AGENT_SESSION_NOT_FOUND");
    }
    const [row] = (
      await client.query<{
        sequence_number: number;
        event_type: string;
        payload: Record<string, unknown>;
        created_at: Date;
      }>(
        `INSERT INTO agent_events (session_id, sequence_number, event_type, payload)
         VALUES ($1,$2,$3,$4::JSONB)
         RETURNING sequence_number, event_type, payload, created_at`,
        [
          sessionId,
          sequence.rows[0].sequence_number,
          event.eventType,
          JSON.stringify(event.payload),
        ],
      )
    ).rows;
    return {
      sequenceNumber: row!.sequence_number,
      eventType: row!.event_type,
      payload: row!.payload,
      createdAt: row!.created_at,
    };
  });
}

export async function insertAgentEvents(
  sessionId: string,
  events: Array<{ eventType: string; payload: Record<string, unknown> }>,
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  for (const event of events) {
    await appendAgentEvent(sessionId, event);
  }
}

export async function listAgentEventsAfter(
  sessionId: string,
  afterSequence: number,
  limit = 100,
): Promise<AgentEvent[]> {
  const rows = await query<{
    sequence_number: number;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT sequence_number, event_type, payload, created_at
       FROM agent_events
      WHERE session_id = $1 AND sequence_number > $2
      ORDER BY sequence_number
      LIMIT $3`,
    [sessionId, afterSequence, limit],
  );
  return rows.map((event) => ({
    sequenceNumber: event.sequence_number,
    eventType: event.event_type,
    payload: event.payload,
    createdAt: event.created_at,
  }));
}

export async function insertAgentPermissionRequest(input: {
  sessionId: string;
  providerRequestId: string;
  toolCall: Record<string, unknown>;
  options: Array<Record<string, unknown>>;
}): Promise<AgentPermissionRequest> {
  const [row] = await query<{
    id: string;
    session_id: string;
    provider_request_id: string;
    tool_call: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
    status: AgentPermissionRequest["status"];
    selected_option_id: string | null;
    requested_at: Date;
    resolved_at: Date | null;
    resolved_by: string | null;
  }>(
    `INSERT INTO agent_permission_requests (
       id, session_id, provider_request_id, tool_call, options
     ) VALUES ($1,$2,$3,$4::JSONB,$5::JSONB)
     ON CONFLICT (session_id, provider_request_id) DO UPDATE
       SET tool_call = EXCLUDED.tool_call,
           options = EXCLUDED.options
     RETURNING *`,
    [
      randomUUID(),
      input.sessionId,
      input.providerRequestId,
      JSON.stringify(input.toolCall),
      JSON.stringify(input.options),
    ],
  );
  return mapAgentPermissionRequest(row!);
}

function mapAgentPermissionRequest(row: {
  id: string;
  session_id: string;
  provider_request_id: string;
  tool_call: Record<string, unknown>;
  options: Array<Record<string, unknown>>;
  status: AgentPermissionRequest["status"];
  selected_option_id: string | null;
  requested_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
}): AgentPermissionRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    providerRequestId: row.provider_request_id,
    toolCall: row.tool_call,
    options: row.options,
    status: row.status,
    selectedOptionId: row.selected_option_id,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

export async function getAgentPermissionRequest(
  permissionRequestId: string,
): Promise<AgentPermissionRequest> {
  const [row] = await query<{
    id: string;
    session_id: string;
    provider_request_id: string;
    tool_call: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
    status: AgentPermissionRequest["status"];
    selected_option_id: string | null;
    requested_at: Date;
    resolved_at: Date | null;
    resolved_by: string | null;
  }>("SELECT * FROM agent_permission_requests WHERE id = $1", [permissionRequestId]);
  if (!row) {
    throw new AppError("Permission request not found", 404, "PERMISSION_REQUEST_NOT_FOUND");
  }
  return mapAgentPermissionRequest(row);
}

export async function listAgentPermissionRequests(
  taskId: string,
): Promise<AgentPermissionRequest[]> {
  const rows = await query<{
    id: string;
    session_id: string;
    provider_request_id: string;
    tool_call: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
    status: AgentPermissionRequest["status"];
    selected_option_id: string | null;
    requested_at: Date;
    resolved_at: Date | null;
    resolved_by: string | null;
  }>(
    `SELECT permission.*
       FROM agent_permission_requests permission
       JOIN agent_sessions session ON session.id = permission.session_id
      WHERE session.task_id = $1
      ORDER BY permission.requested_at DESC`,
    [taskId],
  );
  return rows.map(mapAgentPermissionRequest);
}

export async function listIntegrationAgentPermissionRequests(
  integrationId: string,
): Promise<AgentPermissionRequest[]> {
  const rows = await query<{
    id: string;
    session_id: string;
    provider_request_id: string;
    tool_call: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
    status: AgentPermissionRequest["status"];
    selected_option_id: string | null;
    requested_at: Date;
    resolved_at: Date | null;
    resolved_by: string | null;
  }>(
    `SELECT permission.*
       FROM agent_permission_requests permission
       JOIN agent_sessions session ON session.id = permission.session_id
      WHERE session.integration_id = $1
      ORDER BY permission.requested_at DESC`,
    [integrationId],
  );
  return rows.map(mapAgentPermissionRequest);
}

export async function listProjectMergePlanAgentPermissionRequests(
  projectMergePlanRunId: string,
): Promise<AgentPermissionRequest[]> {
  const rows = await query<{
    id: string;
    session_id: string;
    provider_request_id: string;
    tool_call: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
    status: AgentPermissionRequest["status"];
    selected_option_id: string | null;
    requested_at: Date;
    resolved_at: Date | null;
    resolved_by: string | null;
  }>(
    `SELECT permission.*
       FROM agent_permission_requests permission
       JOIN agent_sessions session ON session.id = permission.session_id
      WHERE session.project_merge_plan_run_id = $1
      ORDER BY permission.requested_at DESC`,
    [projectMergePlanRunId],
  );
  return rows.map(mapAgentPermissionRequest);
}

export async function resolveAgentPermissionRequest(input: {
  permissionRequestId: string;
  selectedOptionId: string | null;
  resolvedBy: string;
}): Promise<AgentPermissionRequest> {
  const [row] = await query<{
    id: string;
    session_id: string;
    provider_request_id: string;
    tool_call: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
    status: AgentPermissionRequest["status"];
    selected_option_id: string | null;
    requested_at: Date;
    resolved_at: Date | null;
    resolved_by: string | null;
  }>(
    `UPDATE agent_permission_requests
        SET status = CASE WHEN $2 IS NULL THEN 'cancelled' ELSE 'selected' END,
            selected_option_id = $2,
            resolved_at = NOW(),
            resolved_by = $3
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [input.permissionRequestId, input.selectedOptionId, input.resolvedBy],
  );
  if (!row) {
    return getAgentPermissionRequest(input.permissionRequestId);
  }
  return mapAgentPermissionRequest(row);
}

export async function listAgentSessions(taskId: string): Promise<AgentSession[]> {
  const rows = await query<AgentSessionRow>(
    `SELECT s.*, a.display_name AS agent_display_name
       FROM agent_sessions s
       LEFT JOIN agent_connections a ON a.id = s.agent_connection_id
      WHERE s.task_id = $1
      ORDER BY s.started_at DESC`,
    [taskId],
  );
  const sessions = rows.map(mapAgentSession);
  for (const session of sessions) {
    const events = await query<{
      sequence_number: number;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT sequence_number, event_type, payload, created_at
         FROM agent_events WHERE session_id = $1 ORDER BY sequence_number`,
      [session.id],
    );
    session.events = events.map<AgentEvent>((event) => ({
      sequenceNumber: event.sequence_number,
      eventType: event.event_type,
      payload: event.payload,
      createdAt: event.created_at,
    }));
  }
  return sessions;
}

export async function listIntegrationAgentSessions(
  integrationId: string,
): Promise<AgentSession[]> {
  const rows = await query<AgentSessionRow>(
    `SELECT s.*, a.display_name AS agent_display_name
       FROM agent_sessions s
       LEFT JOIN agent_connections a ON a.id = s.agent_connection_id
      WHERE s.integration_id = $1
      ORDER BY s.started_at DESC`,
    [integrationId],
  );
  const sessions = rows.map(mapAgentSession);
  for (const session of sessions) {
    session.events = await listAgentEventsAfter(session.id, 0, 500);
  }
  return sessions;
}

export async function listProjectMergePlanAgentSessions(
  projectMergePlanRunId: string,
): Promise<AgentSession[]> {
  const rows = await query<AgentSessionRow>(
    `SELECT s.*, a.display_name AS agent_display_name
       FROM agent_sessions s
       LEFT JOIN agent_connections a ON a.id = s.agent_connection_id
      WHERE s.project_merge_plan_run_id = $1
      ORDER BY s.started_at DESC`,
    [projectMergePlanRunId],
  );
  const sessions = rows.map(mapAgentSession);
  for (const session of sessions) {
    session.events = await listAgentEventsAfter(session.id, 0, 500);
  }
  return sessions;
}

export async function insertChangeRequest(input: {
  taskId: string;
  summary: string;
  baseCommit: string;
  headCommit: string;
  changedFiles: ChangedFile[];
  diffStat: string;
  verificationResults: VerificationResult[];
  risks: string[];
  actorId: string;
}): Promise<ChangeRequest> {
  return withTransaction(async (client) => {
    const result = await client.query<ChangeRequestRow>(
      `INSERT INTO change_requests (
         id, task_id, summary, base_commit, head_commit, changed_files,
         diff_stat, verification_results, risks, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6::JSONB,$7,$8::JSONB,$9::JSONB,$10)
       RETURNING *`,
      [
        randomUUID(),
        input.taskId,
        input.summary,
        input.baseCommit,
        input.headCommit,
        JSON.stringify(input.changedFiles),
        input.diffStat,
        JSON.stringify(input.verificationResults),
        JSON.stringify(input.risks),
        input.actorId,
      ],
    );
    await client.query(
      "UPDATE tasks SET status = 'submitted', updated_at = NOW() WHERE id = $1",
      [input.taskId],
    );
    return mapChangeRequest(result.rows[0]!);
  });
}

export async function listChangeRequests(actorId: string): Promise<ChangeRequest[]> {
  const rows = await query<ChangeRequestRow>(
    `SELECT cr.*, t.title AS task_title, t.project_id, t.branch_name, p.name AS project_name
       FROM change_requests cr
       JOIN tasks t ON t.id = cr.task_id
       JOIN projects p ON p.id = t.project_id
       JOIN memberships m
         ON m.organization_id = p.organization_id
        AND m.user_id = $1
      ORDER BY cr.created_at DESC`,
    [actorId],
  );
  return rows.map(mapChangeRequest);
}

export async function getChangeRequest(changeRequestId: string): Promise<ChangeRequest> {
  const [row] = await query<ChangeRequestRow>(
    `SELECT cr.*, t.title AS task_title, t.project_id, t.branch_name, p.name AS project_name
       FROM change_requests cr
       JOIN tasks t ON t.id = cr.task_id
       JOIN projects p ON p.id = t.project_id
      WHERE cr.id = $1`,
    [changeRequestId],
  );
  if (!row) {
    throw new AppError("Change request not found", 404, "CHANGE_REQUEST_NOT_FOUND");
  }
  return mapChangeRequest(row);
}

export async function getLatestChangeRequestForTask(
  taskId: string,
): Promise<ChangeRequest | null> {
  const [row] = await query<ChangeRequestRow>(
    `SELECT cr.*, t.title AS task_title, t.project_id, t.branch_name, p.name AS project_name
       FROM change_requests cr
       JOIN tasks t ON t.id = cr.task_id
       JOIN projects p ON p.id = t.project_id
      WHERE cr.task_id = $1
      ORDER BY cr.created_at DESC
      LIMIT 1`,
    [taskId],
  );
  return row ? mapChangeRequest(row) : null;
}

export async function listLatestChangeRequestsForProject(
  projectId: string,
): Promise<ChangeRequest[]> {
  const rows = await query<ChangeRequestRow>(
    `SELECT DISTINCT ON (cr.task_id)
            cr.*, t.title AS task_title, t.project_id, t.branch_name, p.name AS project_name
       FROM change_requests cr
       JOIN tasks t ON t.id = cr.task_id
       JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = $1
      ORDER BY cr.task_id, cr.created_at DESC`,
    [projectId],
  );
  return rows.map(mapChangeRequest);
}

export async function insertProjectMergePlanAgentRun(input: {
  projectId: string;
  agentConnectionId: string;
  instruction: string;
  baselinePlan: ProjectMergePlan;
  dependencies: TaskDependency[];
  analysisPrompt: string;
  actorId: string;
}): Promise<ProjectMergePlanAgentRun> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.projectId]);
    const active = await client.query(
      `SELECT id
         FROM project_merge_plan_agent_runs
        WHERE project_id = $1 AND status IN ('starting', 'running')`,
      [input.projectId],
    );
    if (active.rowCount) {
      throw new AppError(
        "This project already has a Merge Planning Agent running",
        409,
        "MERGE_PLAN_AGENT_ALREADY_RUNNING",
      );
    }
    const result = await client.query<ProjectMergePlanAgentRunRow>(
      `INSERT INTO project_merge_plan_agent_runs (
         id, project_id, agent_connection_id, status, instruction,
         baseline_plan, dependencies, analysis_prompt, created_by
       ) VALUES ($1,$2,$3,'starting',$4,$5::JSONB,$6::JSONB,$7,$8)
       RETURNING *`,
      [
        randomUUID(),
        input.projectId,
        input.agentConnectionId,
        input.instruction,
        JSON.stringify(input.baselinePlan),
        JSON.stringify(input.dependencies),
        input.analysisPrompt,
        input.actorId,
      ],
    );
    return mapProjectMergePlanAgentRun(result.rows[0]!);
  });
}

export async function getProjectMergePlanAgentRun(
  runId: string,
): Promise<ProjectMergePlanAgentRun> {
  const [row] = await query<ProjectMergePlanAgentRunRow>(
    `SELECT run.*, connection.display_name AS agent_display_name,
            session.id AS session_id
       FROM project_merge_plan_agent_runs run
       JOIN agent_connections connection ON connection.id = run.agent_connection_id
       LEFT JOIN LATERAL (
         SELECT id
           FROM agent_sessions
          WHERE project_merge_plan_run_id = run.id
          ORDER BY started_at DESC
          LIMIT 1
       ) session ON TRUE
      WHERE run.id = $1`,
    [runId],
  );
  if (!row) {
    throw new AppError("Merge Planning Agent run not found", 404, "MERGE_PLAN_AGENT_RUN_NOT_FOUND");
  }
  return mapProjectMergePlanAgentRun(row);
}

export async function getLatestProjectMergePlanAgentRun(
  projectId: string,
): Promise<ProjectMergePlanAgentRun | null> {
  const [row] = await query<ProjectMergePlanAgentRunRow>(
    `SELECT run.*, connection.display_name AS agent_display_name,
            session.id AS session_id
       FROM project_merge_plan_agent_runs run
       JOIN agent_connections connection ON connection.id = run.agent_connection_id
       LEFT JOIN LATERAL (
         SELECT id
           FROM agent_sessions
          WHERE project_merge_plan_run_id = run.id
          ORDER BY started_at DESC
          LIMIT 1
       ) session ON TRUE
      WHERE run.project_id = $1
      ORDER BY run.created_at DESC
      LIMIT 1`,
    [projectId],
  );
  return row ? mapProjectMergePlanAgentRun(row) : null;
}

export async function updateProjectMergePlanAgentRun(input: {
  runId: string;
  status: ProjectMergePlanAgentRun["status"];
  suggestion?: SemanticMergePlanSuggestion | null;
  rawResponse?: string | null;
  errorMessage?: string | null;
}): Promise<ProjectMergePlanAgentRun> {
  const [row] = await query<ProjectMergePlanAgentRunRow>(
    `UPDATE project_merge_plan_agent_runs
        SET status = $2,
            suggestion = CASE WHEN $3::BOOLEAN THEN $4::JSONB ELSE suggestion END,
            raw_response = CASE WHEN $5::BOOLEAN THEN $6 ELSE raw_response END,
            error_message = $7,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      input.runId,
      input.status,
      input.suggestion !== undefined,
      input.suggestion === undefined ? null : JSON.stringify(input.suggestion),
      input.rawResponse !== undefined,
      input.rawResponse ?? null,
      input.errorMessage ?? null,
    ],
  );
  if (!row) {
    throw new AppError("Merge Planning Agent run not found", 404, "MERGE_PLAN_AGENT_RUN_NOT_FOUND");
  }
  return mapProjectMergePlanAgentRun(row);
}

async function loadProjectIntegrationQueue(
  client: pg.PoolClient,
  queueId: string,
): Promise<ProjectIntegrationQueue> {
  const queueResult = await client.query<ProjectIntegrationQueueRow>(
    "SELECT * FROM project_integration_queues WHERE id = $1",
    [queueId],
  );
  const queue = queueResult.rows[0];
  if (!queue) {
    throw new AppError("Integration queue not found", 404, "INTEGRATION_QUEUE_NOT_FOUND");
  }
  const itemResult = await client.query<ProjectIntegrationQueueItemRow>(
    `SELECT item.position,
            item.task_id,
            task.title AS task_title,
            task.status AS task_status,
            item.change_request_id,
            change_request.status AS change_request_status,
            item.head_commit
       FROM project_integration_queue_items item
       JOIN tasks task ON task.id = item.task_id
       JOIN change_requests change_request ON change_request.id = item.change_request_id
      WHERE item.queue_id = $1
      ORDER BY item.position`,
    [queueId],
  );
  return mapProjectIntegrationQueue(
    queue,
    itemResult.rows.map(mapProjectIntegrationQueueItem),
  );
}

async function loadProjectIntegrationQueueRecord(
  row: ProjectIntegrationQueueRow,
): Promise<ProjectIntegrationQueue> {
  const items = await query<ProjectIntegrationQueueItemRow>(
    `SELECT item.position,
            item.task_id,
            task.title AS task_title,
            task.status AS task_status,
            item.change_request_id,
            change_request.status AS change_request_status,
            item.head_commit
       FROM project_integration_queue_items item
       JOIN tasks task ON task.id = item.task_id
       JOIN change_requests change_request ON change_request.id = item.change_request_id
      WHERE item.queue_id = $1
      ORDER BY item.position`,
    [row.id],
  );
  return mapProjectIntegrationQueue(row, items.map(mapProjectIntegrationQueueItem));
}

export async function replaceProjectIntegrationQueueRecord(input: {
  projectId: string;
  source: IntegrationQueueSource;
  sourceMergePlanRunId: string | null;
  createdBy: string;
  items: Array<{
    taskId: string;
    changeRequestId: string;
    headCommit: string;
  }>;
}): Promise<ProjectIntegrationQueue> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `project-integration-queue:${input.projectId}`,
    ]);
    await client.query(
      `UPDATE project_integration_queues
          SET status = 'cancelled',
              cancelled_by = $2,
              cancellation_reason = 'Replaced by a newer integration queue',
              cancelled_at = NOW(),
              updated_at = NOW()
        WHERE project_id = $1 AND status = 'active'`,
      [input.projectId, input.createdBy],
    );
    const queueId = randomUUID();
    await client.query(
      `INSERT INTO project_integration_queues (
         id, project_id, status, source, source_merge_plan_run_id, created_by
       ) VALUES ($1,$2,'active',$3,$4,$5)`,
      [
        queueId,
        input.projectId,
        input.source,
        input.sourceMergePlanRunId,
        input.createdBy,
      ],
    );
    for (const [index, item] of input.items.entries()) {
      await client.query(
        `INSERT INTO project_integration_queue_items (
           queue_id, position, task_id, change_request_id, head_commit
         ) VALUES ($1,$2,$3,$4,$5)`,
        [queueId, index + 1, item.taskId, item.changeRequestId, item.headCommit],
      );
    }
    return loadProjectIntegrationQueue(client, queueId);
  });
}

export async function getActiveProjectIntegrationQueue(
  projectId: string,
): Promise<ProjectIntegrationQueue | null> {
  const [row] = await query<ProjectIntegrationQueueRow>(
    `SELECT *
       FROM project_integration_queues
      WHERE project_id = $1 AND status = 'active'
      LIMIT 1`,
    [projectId],
  );
  return row ? loadProjectIntegrationQueueRecord(row) : null;
}

export async function getProjectIntegrationQueueRecord(
  queueId: string,
): Promise<ProjectIntegrationQueue> {
  const [row] = await query<ProjectIntegrationQueueRow>(
    "SELECT * FROM project_integration_queues WHERE id = $1",
    [queueId],
  );
  if (!row) {
    throw new AppError("Integration queue not found", 404, "INTEGRATION_QUEUE_NOT_FOUND");
  }
  return loadProjectIntegrationQueueRecord(row);
}

export async function listProjectIntegrationQueues(
  projectId: string,
  limit = 20,
): Promise<ProjectIntegrationQueue[]> {
  const rows = await query<ProjectIntegrationQueueRow>(
    `SELECT *
       FROM project_integration_queues
      WHERE project_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [projectId, Math.min(Math.max(limit, 1), 100)],
  );
  return Promise.all(rows.map(loadProjectIntegrationQueueRecord));
}

export async function getIntegrationQueueForChangeRequest(
  changeRequestId: string,
): Promise<ProjectIntegrationQueue | null> {
  const [row] = await query<ProjectIntegrationQueueRow>(
    `SELECT queue.*
       FROM project_integration_queues queue
       JOIN project_integration_queue_items item ON item.queue_id = queue.id
      WHERE queue.status = 'active' AND item.change_request_id = $1
      LIMIT 1`,
    [changeRequestId],
  );
  return row ? loadProjectIntegrationQueueRecord(row) : null;
}

export async function cancelProjectIntegrationQueueRecord(input: {
  projectId: string;
  actorId: string;
  reason: string;
}): Promise<ProjectIntegrationQueue | null> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `project-integration-queue:${input.projectId}`,
    ]);
    const result = await client.query<ProjectIntegrationQueueRow>(
      `UPDATE project_integration_queues
          SET status = 'cancelled',
              cancelled_by = $2,
              cancellation_reason = $3,
              cancelled_at = NOW(),
              updated_at = NOW()
        WHERE project_id = $1 AND status = 'active'
        RETURNING *`,
      [input.projectId, input.actorId, input.reason],
    );
    const queue = result.rows[0];
    return queue ? loadProjectIntegrationQueue(client, queue.id) : null;
  });
}

export async function refreshProjectIntegrationQueueStatus(
  projectId: string,
): Promise<ProjectIntegrationQueue | null> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `project-integration-queue:${projectId}`,
    ]);
    const activeResult = await client.query<ProjectIntegrationQueueRow>(
      `SELECT *
         FROM project_integration_queues
        WHERE project_id = $1 AND status = 'active'
        FOR UPDATE`,
      [projectId],
    );
    const activeQueue = activeResult.rows[0];
    if (!activeQueue) return null;
    const queue = await loadProjectIntegrationQueue(client, activeQueue.id);
    const completed = queue.items.every((item) =>
      ["merged", "rejected", "cancelled"].includes(item.changeRequestStatus),
    );
    if (!completed) return queue;
    const completedResult = await client.query<ProjectIntegrationQueueRow>(
      `UPDATE project_integration_queues
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [queue.id],
    );
    return mapProjectIntegrationQueue(completedResult.rows[0]!, queue.items);
  });
}

export async function refreshQueuedChangeRequestForTask(input: {
  taskId: string;
  changeRequestId: string;
  headCommit: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const taskResult = await client.query<{ project_id: string }>(
      "SELECT project_id FROM tasks WHERE id = $1",
      [input.taskId],
    );
    const projectId = taskResult.rows[0]?.project_id;
    if (!projectId) return;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `project-integration-queue:${projectId}`,
    ]);
    await client.query(
      `UPDATE project_integration_queue_items item
          SET change_request_id = $2, head_commit = $3
         FROM project_integration_queues queue
        WHERE item.queue_id = queue.id
          AND queue.status = 'active'
          AND item.task_id = $1`,
      [input.taskId, input.changeRequestId, input.headCommit],
    );
  });
}

export async function insertProjectValidationRun(input: {
  projectId: string;
  integrationQueueId: string;
  commands: string[];
  actorId: string;
}): Promise<ProjectValidationRun> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `project-validation:${input.projectId}`,
    ]);
    const queue = await client.query<{ project_id: string; status: string }>(
      "SELECT project_id, status FROM project_integration_queues WHERE id = $1 FOR SHARE",
      [input.integrationQueueId],
    );
    const queueRecord = queue.rows[0];
    if (!queueRecord || queueRecord.project_id !== input.projectId) {
      throw new AppError(
        "The Integration Queue does not belong to this project",
        409,
        "PROJECT_VALIDATION_QUEUE_INVALID",
      );
    }
    if (queueRecord.status !== "completed") {
      throw new AppError(
        "Only a completed Integration Queue can be jointly validated",
        409,
        "PROJECT_VALIDATION_QUEUE_NOT_COMPLETED",
      );
    }
    const active = await client.query(
      `SELECT id FROM project_validation_runs
        WHERE project_id = $1 AND status IN ('queued', 'running')`,
      [input.projectId],
    );
    if (active.rowCount) {
      throw new AppError(
        "This project already has an active joint validation run",
        409,
        "PROJECT_VALIDATION_ALREADY_RUNNING",
      );
    }
    const result = await client.query<ProjectValidationRunRow>(
      `INSERT INTO project_validation_runs (
         id, project_id, integration_queue_id, status, commands, created_by
       ) VALUES ($1,$2,$3,'queued',$4::JSONB,$5)
       RETURNING *`,
      [
        randomUUID(),
        input.projectId,
        input.integrationQueueId,
        JSON.stringify(input.commands),
        input.actorId,
      ],
    );
    return mapProjectValidationRun(result.rows[0]!);
  });
}

export async function getProjectValidationRun(runId: string): Promise<ProjectValidationRun> {
  const [row] = await query<ProjectValidationRunRow>(
    "SELECT * FROM project_validation_runs WHERE id = $1",
    [runId],
  );
  if (!row) {
    throw new AppError(
      "Project validation run not found",
      404,
      "PROJECT_VALIDATION_NOT_FOUND",
    );
  }
  return mapProjectValidationRun(row);
}

export async function listProjectValidationRuns(
  projectId: string,
  limit = 20,
): Promise<ProjectValidationRun[]> {
  const rows = await query<ProjectValidationRunRow>(
    `SELECT * FROM project_validation_runs
      WHERE project_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [projectId, Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map(mapProjectValidationRun);
}

export async function updateProjectValidationRun(input: {
  runId: string;
  status: ProjectValidationRunStatus;
  results?: VerificationResult[];
  mainCommit?: string;
  worktreePath?: string;
  errorMessage?: string | null;
}): Promise<ProjectValidationRun> {
  const [row] = await query<ProjectValidationRunRow>(
    `UPDATE project_validation_runs
        SET status = $2,
            results = CASE WHEN $3::BOOLEAN THEN $4::JSONB ELSE results END,
            main_commit = COALESCE($5, main_commit),
            worktree_path = COALESCE($6, worktree_path),
            error_message = $7,
            started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, NOW()) ELSE started_at END,
            completed_at = CASE WHEN $2 IN ('passed', 'failed') THEN NOW() ELSE completed_at END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      input.runId,
      input.status,
      input.results !== undefined,
      input.results === undefined ? null : JSON.stringify(input.results),
      input.mainCommit ?? null,
      input.worktreePath ?? null,
      input.errorMessage ?? null,
    ],
  );
  if (!row) {
    throw new AppError(
      "Project validation run not found",
      404,
      "PROJECT_VALIDATION_NOT_FOUND",
    );
  }
  return mapProjectValidationRun(row);
}

export async function recordReview(input: {
  changeRequestId: string;
  reviewerId: string;
  decision: ReviewDecision;
  comment: string;
  nextStatus: ChangeRequestStatus;
  nextTaskStatus: TaskStatus;
}): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<{ task_id: string }>(
      `UPDATE change_requests
          SET status = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING task_id`,
      [input.changeRequestId, input.nextStatus],
    );
    const taskId = result.rows[0]?.task_id;
    if (!taskId) {
      throw new AppError("Change request not found", 404, "CHANGE_REQUEST_NOT_FOUND");
    }
    await client.query(
      `INSERT INTO reviews (id, change_request_id, reviewer_id, decision, comment)
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), input.changeRequestId, input.reviewerId, input.decision, input.comment],
    );
    await client.query(
      "UPDATE tasks SET status = $2, updated_at = NOW() WHERE id = $1",
      [taskId, input.nextTaskStatus],
    );
    if (["rejected", "cancelled"].includes(input.nextTaskStatus)) {
      await insertDependencyFailureNotifications(client, taskId);
    }
  });
}

export async function insertIntegrationRun(input: {
  changeRequestId: string;
  branchName: string;
  worktreePath: string;
  actorId: string;
}): Promise<IntegrationRun> {
  const [row] = await query<IntegrationRow>(
    `INSERT INTO integration_runs (
       id, change_request_id, status, branch_name, worktree_path, created_by
     ) VALUES ($1,$2,'merging',$3,$4,$5)
     RETURNING *`,
    [randomUUID(), input.changeRequestId, input.branchName, input.worktreePath, input.actorId],
  );
  await query(
    "UPDATE change_requests SET status = 'integrating', updated_at = NOW() WHERE id = $1",
    [input.changeRequestId],
  );
  return mapIntegration(row!);
}

export async function updateIntegrationRun(input: {
  integrationId: string;
  status: IntegrationRun["status"];
  mergeCommit?: string | null;
  report: Record<string, unknown>;
  changeRequestStatus: ChangeRequestStatus;
}): Promise<IntegrationRun> {
  return withTransaction(async (client) => {
    const result = await client.query<IntegrationRow>(
      `UPDATE integration_runs
          SET status = $2,
              merge_commit = $3,
              report = $4::JSONB,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        input.integrationId,
        input.status,
        input.mergeCommit ?? null,
        JSON.stringify(input.report),
      ],
    );
    const integration = result.rows[0];
    if (!integration) {
      throw new AppError("Integration run not found", 404, "INTEGRATION_NOT_FOUND");
    }
    await client.query(
      "UPDATE change_requests SET status = $2, updated_at = NOW() WHERE id = $1",
      [integration.change_request_id, input.changeRequestStatus],
    );
    return mapIntegration(integration);
  });
}

export async function getIntegrationRun(integrationId: string): Promise<IntegrationRun> {
  const [row] = await query<IntegrationRow>("SELECT * FROM integration_runs WHERE id = $1", [
    integrationId,
  ]);
  if (!row) {
    throw new AppError("Integration run not found", 404, "INTEGRATION_NOT_FOUND");
  }
  return mapIntegration(row);
}

export async function getLatestIntegrationForChangeRequest(
  changeRequestId: string,
): Promise<IntegrationRun | null> {
  const [row] = await query<IntegrationRow>(
    `SELECT * FROM integration_runs
      WHERE change_request_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [changeRequestId],
  );
  return row ? mapIntegration(row) : null;
}

export async function markMerged(input: {
  integrationId: string;
  changeRequestId: string;
  taskId: string;
  reviewerId: string;
  comment: string;
  report: Record<string, unknown>;
}): Promise<void> {
  await withTransaction(async (client: pg.PoolClient) => {
    await client.query(
      `UPDATE integration_runs SET status = 'merged', report = $2::JSONB, updated_at = NOW()
        WHERE id = $1`,
      [input.integrationId, JSON.stringify(input.report)],
    );
    await client.query(
      `UPDATE change_requests SET status = 'merged', updated_at = NOW() WHERE id = $1`,
      [input.changeRequestId],
    );
    await client.query("UPDATE tasks SET status = 'merged', updated_at = NOW() WHERE id = $1", [
      input.taskId,
    ]);
    await client.query(
      `INSERT INTO reviews (id, change_request_id, reviewer_id, decision, comment)
       VALUES ($1,$2,$3,'approve_final',$4)`,
      [randomUUID(), input.changeRequestId, input.reviewerId, input.comment],
    );
  });
}

export async function recordAudit(input: {
  actorId: string | null;
  projectId?: string;
  taskId?: string;
  eventType: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO audit_events (
       id, organization_id, actor_id, project_id, task_id, event_type, payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB)`,
    [
      randomUUID(),
      config.organizationId,
      input.actorId,
      input.projectId ?? null,
      input.taskId ?? null,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function listAuditEventTypes(organizationId: string): Promise<string[]> {
  const rows = await query<{ event_type: string }>(
    `SELECT DISTINCT event_type
       FROM audit_events
      WHERE organization_id = $1
      ORDER BY event_type`,
    [organizationId],
  );
  return rows.map((row) => row.event_type);
}

export async function listAuditEvents(
  organizationId: string,
  filters: AuditQuery,
): Promise<AuditEventPage> {
  const values: unknown[] = [organizationId];
  const conditions = ["ae.organization_id = $1"];
  const addValue = (value: unknown): number => {
    values.push(value);
    return values.length;
  };

  if (filters.actorId) {
    conditions.push(`ae.actor_id = $${addValue(filters.actorId)}`);
  }
  if (filters.projectId) {
    conditions.push(`ae.project_id = $${addValue(filters.projectId)}`);
  }
  if (filters.taskId) {
    conditions.push(`ae.task_id = $${addValue(filters.taskId)}`);
  }
  if (filters.eventType) {
    conditions.push(`ae.event_type = $${addValue(filters.eventType)}`);
  }
  if (filters.from) {
    conditions.push(
      `ae.created_at >= ($${addValue(filters.from)}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`,
    );
  }
  if (filters.to) {
    conditions.push(
      `ae.created_at < (($${addValue(filters.to)}::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Shanghai')`,
    );
  }
  if (filters.search) {
    const searchIndex = addValue(`%${escapeLikePattern(filters.search)}%`);
    conditions.push(
      `CONCAT_WS(' ', ae.event_type, u.name, u.email, p.name, t.title, ae.payload::TEXT)
         ILIKE $${searchIndex} ESCAPE '\\'`,
    );
  }

  const fromSql = `
    FROM audit_events ae
    LEFT JOIN users u ON u.id = ae.actor_id
    LEFT JOIN projects p ON p.id = ae.project_id
    LEFT JOIN tasks t ON t.id = ae.task_id
    WHERE ${conditions.join(" AND ")}`;
  const [countRow] = await query<{ count: string }>(`SELECT COUNT(*)::TEXT AS count ${fromSql}`, values);
  const total = Number(countRow?.count ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
  const page = Math.min(filters.page, pageCount);
  const limitIndex = addValue(filters.pageSize);
  const offsetIndex = addValue((page - 1) * filters.pageSize);
  const rows = await query<AuditEventRow>(
    `SELECT ae.id, ae.organization_id, ae.actor_id, u.name AS actor_name,
            u.email AS actor_email, ae.project_id, p.name AS project_name,
            ae.task_id, t.title AS task_title, ae.event_type, ae.payload, ae.created_at
       ${fromSql}
      ORDER BY ae.created_at DESC, ae.id DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    values,
  );

  return {
    events: rows.map(mapAuditEvent),
    total,
    page,
    pageSize: filters.pageSize,
    pageCount,
  };
}

export async function insertWorkflowExecution(input: {
  workflowId: string;
  runId: string;
  workflowType: string;
  entityType: string;
  entityId: string;
  actorId: string;
}): Promise<void> {
  await query(
    `INSERT INTO workflow_executions (
       id, organization_id, workflow_id, run_id, workflow_type,
       entity_type, entity_id, status, started_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8)
     ON CONFLICT (workflow_id, run_id) DO NOTHING`,
    [
      randomUUID(),
      config.organizationId,
      input.workflowId,
      input.runId,
      input.workflowType,
      input.entityType,
      input.entityId,
      input.actorId,
    ],
  );
}

export async function completeWorkflowExecution(input: {
  workflowId: string;
  runId: string;
  result: unknown;
}): Promise<void> {
  await query(
    `UPDATE workflow_executions
        SET status = 'completed', result = $3::JSONB,
            completed_at = NOW(), updated_at = NOW()
      WHERE workflow_id = $1 AND run_id = $2`,
    [input.workflowId, input.runId, JSON.stringify(input.result ?? null)],
  );
}

export async function failWorkflowExecution(input: {
  workflowId: string;
  runId: string;
  errorMessage: string;
}): Promise<void> {
  await query(
    `UPDATE workflow_executions
        SET status = 'failed', error_message = COALESCE(error_message, $3),
            completed_at = NOW(), updated_at = NOW()
      WHERE workflow_id = $1 AND run_id = $2`,
    [input.workflowId, input.runId, input.errorMessage],
  );
}

export async function listWorkflowExecutions(
  entityType: string,
  entityId: string,
  limit = 20,
): Promise<WorkflowExecution[]> {
  const rows = await query<{
    id: string;
    workflow_id: string;
    run_id: string;
    workflow_type: string;
    entity_type: string;
    entity_id: string;
    status: WorkflowExecution["status"];
    result: Record<string, unknown> | null;
    error_message: string | null;
    started_by: string;
    started_at: Date;
    completed_at: Date | null;
    updated_at: Date;
  }>(
    `SELECT *
       FROM workflow_executions
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY started_at DESC
      LIMIT $3`,
    [entityType, entityId, limit],
  );

  return rows.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    runId: row.run_id,
    workflowType: row.workflow_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status,
    result: row.result,
    errorMessage: row.error_message,
    startedBy: row.started_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  }));
}

export async function getOrganizationRole(
  userId: string,
  organizationId: string,
): Promise<"admin" | "member" | null> {
  const [row] = await query<{ role: "admin" | "member" }>(
    `SELECT role
       FROM memberships
      WHERE user_id = $1 AND organization_id = $2`,
    [userId, organizationId],
  );
  return row?.role ?? null;
}

export async function findUserCredentialByEmail(
  email: string,
): Promise<UserCredentialRecord | null> {
  const [row] = await query<{
    id: string;
    email: string;
    name: string;
    organization_id: string;
    role: "admin" | "member";
    password_hash: string;
    must_change_password: boolean;
    failed_attempts: number;
    locked_until: Date | null;
  }>(
    `SELECT u.id, u.email, u.name, m.organization_id, m.role,
            c.password_hash, c.must_change_password, c.failed_attempts, c.locked_until
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN user_credentials c ON c.user_id = u.id
      WHERE LOWER(u.email) = LOWER($1)
        AND m.organization_id = $2`,
    [email, config.organizationId],
  );

  if (!row) {
    return null;
  }

  return {
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      organizationId: row.organization_id,
      role: row.role,
      mustChangePassword: row.must_change_password,
    },
    passwordHash: row.password_hash,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
  };
}

export async function recordLoginFailure(userId: string): Promise<void> {
  await query(
    `UPDATE user_credentials
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE
              WHEN failed_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes'
              ELSE locked_until
            END,
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId],
  );
}

export async function resetLoginFailures(userId: string): Promise<void> {
  await query(
    `UPDATE user_credentials
        SET failed_attempts = 0, locked_until = NULL, updated_at = NOW()
      WHERE user_id = $1`,
    [userId],
  );
}

export async function insertAuthSession(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  await query(
    `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [randomUUID(), input.userId, input.tokenHash, input.expiresAt],
  );
}

export async function findAuthenticatedUserBySessionHash(
  tokenHash: string,
): Promise<AuthenticatedUser | null> {
  const [row] = await query<{
    id: string;
    email: string;
    name: string;
    organization_id: string;
    role: "admin" | "member";
    must_change_password: boolean;
  }>(
    `UPDATE auth_sessions s
        SET last_seen_at = NOW()
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN user_credentials c ON c.user_id = u.id
      WHERE s.token_hash = $1
        AND s.user_id = u.id
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND m.organization_id = $2
      RETURNING u.id, u.email, u.name, m.organization_id, m.role,
                c.must_change_password`,
    [tokenHash, config.organizationId],
  );

  return row
    ? {
        id: row.id,
        email: row.email,
        name: row.name,
        organizationId: row.organization_id,
        role: row.role,
        mustChangePassword: row.must_change_password,
      }
    : null;
}

export async function revokeAuthSession(tokenHash: string): Promise<void> {
  await query(
    `UPDATE auth_sessions
        SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE token_hash = $1`,
    [tokenHash],
  );
}

export async function revokeAllAuthSessionsForUser(userId: string): Promise<void> {
  await query(
    `UPDATE auth_sessions
        SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE user_id = $1`,
    [userId],
  );
}

export async function findUserCredentialById(
  userId: string,
): Promise<UserCredentialRecord | null> {
  const [row] = await query<{
    id: string;
    email: string;
    name: string;
    organization_id: string;
    role: "admin" | "member";
    password_hash: string;
    must_change_password: boolean;
    failed_attempts: number;
    locked_until: Date | null;
  }>(
    `SELECT u.id, u.email, u.name, m.organization_id, m.role,
            c.password_hash, c.must_change_password, c.failed_attempts, c.locked_until
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN user_credentials c ON c.user_id = u.id
      WHERE u.id = $1
        AND m.organization_id = $2`,
    [userId, config.organizationId],
  );

  return row
    ? {
        user: {
          id: row.id,
          email: row.email,
          name: row.name,
          organizationId: row.organization_id,
          role: row.role,
          mustChangePassword: row.must_change_password,
        },
        passwordHash: row.password_hash,
        failedAttempts: row.failed_attempts,
        lockedUntil: row.locked_until,
      }
    : null;
}

export async function updateUserPassword(input: {
  userId: string;
  passwordHash: string;
}): Promise<void> {
  const rows = await query(
    `UPDATE user_credentials
        SET password_hash = $2,
            must_change_password = FALSE,
            failed_attempts = 0,
            locked_until = NULL,
            updated_at = NOW()
      WHERE user_id = $1
      RETURNING user_id`,
    [input.userId, input.passwordHash],
  );
  if (rows.length === 0) {
    throw new AppError("Account credential not found", 404, "CREDENTIAL_NOT_FOUND");
  }
}

export async function listMembershipInvitations(
  organizationId = config.organizationId,
): Promise<MembershipInvitation[]> {
  const rows = await query<MembershipInvitationRow>(
    `SELECT i.id, i.organization_id, i.email, i.name, i.role,
            CASE
              WHEN i.accepted_at IS NOT NULL THEN 'accepted'
              WHEN i.revoked_at IS NOT NULL THEN 'revoked'
              WHEN i.expires_at <= NOW() THEN 'expired'
              ELSE 'pending'
            END AS status,
            i.expires_at, i.accepted_at, i.revoked_at, i.invited_by,
            inviter.name AS invited_by_name, i.created_at
       FROM membership_invitations i
       JOIN users inviter ON inviter.id = i.invited_by
      WHERE i.organization_id = $1
      ORDER BY i.created_at DESC`,
    [organizationId],
  );
  return rows.map(mapMembershipInvitation);
}

export async function findMembershipInvitationByTokenHash(
  tokenHash: string,
): Promise<MembershipInvitation | null> {
  const [row] = await query<MembershipInvitationRow>(
    `SELECT i.id, i.organization_id, i.email, i.name, i.role,
            CASE
              WHEN i.accepted_at IS NOT NULL THEN 'accepted'
              WHEN i.revoked_at IS NOT NULL THEN 'revoked'
              WHEN i.expires_at <= NOW() THEN 'expired'
              ELSE 'pending'
            END AS status,
            i.expires_at, i.accepted_at, i.revoked_at, i.invited_by,
            inviter.name AS invited_by_name, i.created_at
       FROM membership_invitations i
       JOIN users inviter ON inviter.id = i.invited_by
      WHERE i.token_hash = $1`,
    [tokenHash],
  );
  return row ? mapMembershipInvitation(row) : null;
}

export async function insertMembershipInvitation(input: {
  organizationId: string;
  email: string;
  name: string;
  role: "admin" | "member";
  tokenHash: string;
  expiresAt: Date;
  invitedBy: string;
}): Promise<MembershipInvitation> {
  return withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`${input.organizationId}:${input.email.toLowerCase()}`],
    );
    await client.query(
      `UPDATE membership_invitations
          SET revoked_at = NOW()
        WHERE organization_id = $1
          AND LOWER(email) = LOWER($2)
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at <= NOW()`,
      [input.organizationId, input.email],
    );

    const existingMember = await client.query(
      `SELECT u.id
         FROM users u
         JOIN memberships m ON m.user_id = u.id
        WHERE LOWER(u.email) = LOWER($1)
          AND m.organization_id = $2`,
      [input.email, input.organizationId],
    );
    if (existingMember.rowCount) {
      throw new AppError("This email already belongs to an organization member", 409, "MEMBER_ALREADY_EXISTS");
    }

    const activeInvitation = await client.query(
      `SELECT id
         FROM membership_invitations
        WHERE organization_id = $1
          AND LOWER(email) = LOWER($2)
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > NOW()`,
      [input.organizationId, input.email],
    );
    if (activeInvitation.rowCount) {
      throw new AppError("This email already has an active invitation", 409, "INVITATION_ALREADY_EXISTS");
    }

    const id = randomUUID();
    const result = await client.query<MembershipInvitationRow>(
      `INSERT INTO membership_invitations (
         id, organization_id, email, name, role, token_hash,
         expires_at, invited_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, organization_id, email, name, role, 'pending' AS status,
                 expires_at, accepted_at, revoked_at, invited_by, created_at`,
      [
        id,
        input.organizationId,
        input.email,
        input.name,
        input.role,
        input.tokenHash,
        input.expiresAt,
        input.invitedBy,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError("Failed to create invitation", 500, "INVITATION_CREATE_FAILED");
    }

    await client.query(
      `INSERT INTO audit_events (
         id, organization_id, actor_id, event_type, payload
       ) VALUES ($1,$2,$3,'membership.invitation_created',$4::JSONB)`,
      [
        randomUUID(),
        input.organizationId,
        input.invitedBy,
        JSON.stringify({ invitationId: id, email: input.email, role: input.role }),
      ],
    );
    return mapMembershipInvitation(row);
  });
}

export async function revokeMembershipInvitationRecord(input: {
  invitationId: string;
  organizationId: string;
  actorId: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<{ email: string }>(
      `UPDATE membership_invitations
          SET revoked_at = NOW(), revoked_by = $3
        WHERE id = $1
          AND organization_id = $2
          AND accepted_at IS NULL
          AND revoked_at IS NULL
        RETURNING email`,
      [input.invitationId, input.organizationId, input.actorId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError("The invitation does not exist or can no longer be revoked", 409, "INVITATION_NOT_REVOCABLE");
    }
    await client.query(
      `INSERT INTO audit_events (
         id, organization_id, actor_id, event_type, payload
       ) VALUES ($1,$2,$3,'membership.invitation_revoked',$4::JSONB)`,
      [
        randomUUID(),
        input.organizationId,
        input.actorId,
        JSON.stringify({ invitationId: input.invitationId, email: row.email }),
      ],
    );
  });
}

export async function acceptMembershipInvitationRecord(input: {
  tokenHash: string;
  passwordHash: string;
}): Promise<AuthenticatedUser> {
  return withTransaction(async (client) => {
    const invitationResult = await client.query<{
      id: string;
      organization_id: string;
      email: string;
      name: string;
      role: "admin" | "member";
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, organization_id, email, name, role, expires_at, accepted_at, revoked_at
         FROM membership_invitations
        WHERE token_hash = $1
        FOR UPDATE`,
      [input.tokenHash],
    );
    const invitation = invitationResult.rows[0];
    if (!invitation) {
      throw new AppError("Invalid invitation link", 404, "INVITATION_NOT_FOUND");
    }
    if (invitation.accepted_at) {
      throw new AppError("This invitation has already been accepted", 409, "INVITATION_ALREADY_ACCEPTED");
    }
    if (invitation.revoked_at) {
      throw new AppError("This invitation has been revoked", 410, "INVITATION_REVOKED");
    }
    if (invitation.expires_at.getTime() <= Date.now()) {
      throw new AppError("This invitation has expired", 410, "INVITATION_EXPIRED");
    }

    const existingUserResult = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) FOR UPDATE`,
      [invitation.email],
    );
    const existingUser = existingUserResult.rows[0];
    const userId = existingUser?.id ?? randomUUID();

    if (existingUser) {
      const membershipResult = await client.query(
        `SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2`,
        [invitation.organization_id, userId],
      );
      if (membershipResult.rowCount) {
        throw new AppError("This account is already an organization member", 409, "MEMBER_ALREADY_EXISTS");
      }
      await client.query(`UPDATE users SET name = $2 WHERE id = $1`, [userId, invitation.name]);
    } else {
      await client.query(
        `INSERT INTO users (id, email, name) VALUES ($1,$2,$3)`,
        [userId, invitation.email, invitation.name],
      );
    }

    await client.query(
      `INSERT INTO user_credentials (
         user_id, password_hash, must_change_password, failed_attempts, locked_until, updated_at
       ) VALUES ($1,$2,FALSE,0,NULL,NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             must_change_password = FALSE,
             failed_attempts = 0,
             locked_until = NULL,
             updated_at = NOW()`,
      [userId, input.passwordHash],
    );
    await client.query(
      `INSERT INTO memberships (organization_id, user_id, role)
       VALUES ($1,$2,$3)`,
      [invitation.organization_id, userId, invitation.role],
    );
    await client.query(
      `UPDATE membership_invitations
          SET accepted_at = NOW(), accepted_by = $2
        WHERE id = $1`,
      [invitation.id, userId],
    );
    await client.query(
      `INSERT INTO audit_events (
         id, organization_id, actor_id, event_type, payload
       ) VALUES ($1,$2,$3,'membership.invitation_accepted',$4::JSONB)`,
      [
        randomUUID(),
        invitation.organization_id,
        userId,
        JSON.stringify({ invitationId: invitation.id, email: invitation.email }),
      ],
    );

    return {
      id: userId,
      email: invitation.email,
      name: invitation.name,
      organizationId: invitation.organization_id,
      role: invitation.role,
      mustChangePassword: false,
    };
  });
}
