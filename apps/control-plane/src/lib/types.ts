import type { ChangeRequestStatus, TaskStatus } from "./domain";

export interface User {
  id: string;
  email: string;
  name: string;
  role?: "admin" | "member";
}

export interface AuthenticatedUser extends User {
  organizationId: string;
  role: "admin" | "member";
  mustChangePassword: boolean;
}

export interface MembershipInvitation {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: "admin" | "member";
  status: "pending" | "expired" | "accepted" | "revoked";
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  invitedBy: string;
  invitedByName?: string;
  createdAt: Date;
}

export interface AgentConnection {
  id: string;
  userId: string;
  provider: string;
  displayName: string;
  protocol: "acp" | "yoke" | "local" | "openai-compatible";
  status: "ready" | "disabled" | "error";
  model: string | null;
  credentialConfigured: boolean;
  credentialVersion: number;
  credentialConfiguredAt: Date | null;
  credentialRotatedAt: Date | null;
  credentialRevokedAt: Date | null;
  credentialLastUsedAt: Date | null;
  launcherCommand: string | null;
  launcherArguments: string[];
  credentialEnvironmentVariable: string;
  apiBaseUrl: string | null;
  maxToolRounds: number;
}

export interface CredentialAccessEvent {
  id: string;
  agentConnectionId: string;
  actorId: string;
  taskId: string | null;
  integrationId: string | null;
  sessionId: string | null;
  runnerId: string | null;
  eventType: "configured" | "rotated" | "used" | "revoked";
  credentialVersion: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AgentCredentialLease {
  id: string;
  agentConnectionId: string;
  credentialVersion: number;
  actorId: string;
  taskId: string | null;
  integrationId: string | null;
  sessionId: string | null;
  runnerId: string | null;
  status: "active" | "released" | "expired" | "revoked";
  issuedAt: Date;
  expiresAt: Date;
  releasedAt: Date | null;
  releaseReason: string | null;
}

export interface AgentEvent {
  sequenceNumber: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface AgentSession {
  id: string;
  taskId: string | null;
  integrationId: string | null;
  projectMergePlanRunId: string | null;
  agentConnectionId: string | null;
  runnerId: string | null;
  status: "starting" | "running" | "waiting" | "stopped" | "failed" | "completed";
  prompt: string;
  finalMessage: string | null;
  errorMessage: string | null;
  providerSessionId: string | null;
  parentSessionId: string | null;
  stopReason: string | null;
  transportMetadata: Record<string, unknown>;
  cancelRequestedAt: Date | null;
  cancelledBy: string | null;
  startedAt: Date;
  endedAt: Date | null;
  updatedAt: Date;
  agentDisplayName?: string | null;
  events?: AgentEvent[];
}

export interface AgentPermissionRequest {
  id: string;
  sessionId: string;
  providerRequestId: string;
  toolCall: Record<string, unknown>;
  options: Array<Record<string, unknown>>;
  status: "pending" | "selected" | "cancelled" | "expired";
  selectedOptionId: string | null;
  requestedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  giteaOwner: string;
  giteaRepository: string;
  repositoryUrl: string;
  defaultBranch: string;
  localRepositoryPath: string;
  createdBy: string;
  createdAt: Date;
  taskCount?: number;
  pendingReviewCount?: number;
}

export interface ProjectMember extends User {
  explicitMembership: boolean;
  addedBy: string | null;
  addedAt: Date | null;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  verificationCommands: string[];
  expectedChangeScopes: string[];
  status: TaskStatus;
  baseBranch: string;
  baseCommit: string | null;
  branchName: string | null;
  worktreePath: string | null;
  assignedUserId: string;
  agentConnectionId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  assignedUserName?: string;
  agentDisplayName?: string | null;
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
  dependsOnTitle: string;
  dependsOnStatus: TaskStatus;
  createdBy: string;
  createdAt: Date;
}

export interface TaskDependencyRevisionEntry {
  taskId: string;
  title: string;
  status: TaskStatus;
}

export type TaskDependencyRevisionKind =
  | "task_created"
  | "manual_update"
  | "failure_recovery";

export interface TaskDependencyRevision {
  id: string;
  projectId: string;
  taskId: string;
  actorId: string | null;
  actorName: string;
  changeKind: TaskDependencyRevisionKind;
  changeReason: string | null;
  previousDependencies: TaskDependencyRevisionEntry[];
  nextDependencies: TaskDependencyRevisionEntry[];
  addedDependencies: TaskDependencyRevisionEntry[];
  removedDependencies: TaskDependencyRevisionEntry[];
  createdAt: Date;
}

export interface TaskScopeConflict {
  leftTaskId: string;
  leftTaskTitle: string;
  rightTaskId: string;
  rightTaskTitle: string;
  overlaps: Array<{ leftScope: string; rightScope: string }>;
}

export interface TaskWorkspaceProgress {
  baseCommit: string;
  headCommit: string;
  mainCommit: string;
  committedFiles: ChangedFile[];
  uncommittedFiles: ChangedFile[];
  actualChangedFiles: string[];
  mainChangedFiles: ChangedFile[];
  overlappingFiles: string[];
  structuralConflicts: WorkspaceStructuralConflict[];
  mainCommitsSinceBase: number;
  mainAdvanced: boolean;
  workingTreeClean: boolean;
  checkedAt: string;
}

export interface TaskWorkspaceSnapshot extends TaskWorkspaceProgress {
  id: string;
  taskId: string;
  observedBy: string | null;
  createdAt: string;
}

export interface TaskWorkspaceBackup {
  taskId: string;
  projectId: string;
  branchName: string;
  remoteHeadCommit: string | null;
  checkpointCommit: string | null;
  workingTreeClean: boolean;
  changedFiles: ChangedFile[];
  status: "synced" | "failed" | "restored";
  errorMessage: string | null;
  syncAttemptedAt: Date;
  lastSyncedAt: Date | null;
  lastCheckpointAt: Date | null;
  lastRestoredAt: Date | null;
  restoredBy: string | null;
  updatedAt: Date;
}

export interface ProjectNotification {
  id: string;
  projectId: string;
  taskId: string | null;
  taskTitle: string | null;
  kind: string;
  severity: "info" | "warning" | "danger";
  title: string;
  message: string;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface VerificationResult {
  command: string;
  exitCode: number;
  output: string;
  durationMs: number;
}

export interface ChangedFile {
  status: string;
  path: string;
  previousPath?: string | null;
}

export type WorkspaceStructuralConflictKind =
  | "rename_collision"
  | "directory_overlap"
  | "semantic_pair"
  | "import_dependency";

export interface WorkspaceStructuralConflict {
  kind: WorkspaceStructuralConflictKind;
  severity: "warning" | "danger";
  taskPath: string;
  mainPath: string;
  message: string;
}

export interface ChangeRequest {
  id: string;
  taskId: string;
  status: ChangeRequestStatus;
  summary: string;
  baseCommit: string;
  headCommit: string;
  changedFiles: ChangedFile[];
  diffStat: string;
  verificationResults: VerificationResult[];
  risks: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  taskTitle?: string;
  projectId?: string;
  projectName?: string;
  branchName?: string | null;
}

export interface IntegrationRun {
  id: string;
  changeRequestId: string;
  status:
    | "merging"
    | "needs_agent"
    | "verification_failed"
    | "awaiting_final_approval"
    | "merged"
    | "failed";
  branchName: string;
  worktreePath: string;
  mergeCommit: string | null;
  report: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRunner {
  id: string;
  taskId: string | null;
  integrationId: string | null;
  projectMergePlanRunId: string | null;
  projectValidationRunId: string | null;
  provider: "aio-sandbox";
  containerName: string;
  image: string;
  status: "starting" | "running" | "stopped" | "failed" | "destroyed";
  baseUrl: string | null;
  hostPort: number | null;
  workspacePath: string;
  containerWorkspacePath: string;
  credentialRef: string;
  resourceLimits: Record<string, string>;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskPreviewRun {
  id: string;
  taskId: string;
  runnerId: string;
  command: string;
  port: number;
  status: "starting" | "running" | "completed" | "stopped" | "failed";
  shellSessionId: string;
  previewUrl: string;
  output: string;
  exitCode: number | null;
  errorMessage: string | null;
  startedBy: string;
  stoppedBy: string | null;
  startedAt: Date;
  endedAt: Date | null;
  updatedAt: Date;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  runId: string;
  workflowType: string;
  entityType: string;
  entityId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "terminated";
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  startedBy: string;
  startedAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
}
