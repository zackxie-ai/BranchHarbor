export interface ActorOperationInput {
  actorId: string;
}

export interface TaskOperationInput extends ActorOperationInput {
  taskId: string;
}

export interface TaskWorkspaceMonitorInput extends TaskOperationInput {
  generation?: number;
  maxChecksPerRun?: number;
  pollIntervalMs?: number;
}

export interface TaskWorkspaceMonitorCaptureResult {
  continueMonitoring: boolean;
  snapshotCreated: boolean;
  reason: string;
  errorMessage: string | null;
}

export interface TaskWorkspaceMonitorResult {
  taskId: string;
  status: "stopped";
  reason: string;
  checks: number;
  snapshotsCreated: number;
}

export interface SubmitTaskInput extends TaskOperationInput {
  summary: string;
  risks: string[];
}

export interface RunTaskAgentInput extends TaskOperationInput {
  prompt: string;
  resumeSessionId?: string;
}

export interface RunIntegrationAgentInput extends ActorOperationInput {
  integrationId: string;
  agentConnectionId: string;
  prompt: string;
  resumeSessionId?: string;
}

export interface RunProjectMergePlanAgentInput extends ActorOperationInput {
  runId: string;
}

export interface RunProjectValidationInput extends ActorOperationInput {
  runId: string;
}

export interface ChangeRequestOperationInput extends ActorOperationInput {
  changeRequestId: string;
}

export interface FinalizeIntegrationInput extends ActorOperationInput {
  integrationId: string;
  comment?: string;
}

export interface ProvisionTaskResult {
  taskId: string;
  runnerId: string;
}

export interface StartRunnerResult {
  runnerId: string;
}

export interface CancelTaskResult {
  taskId: string;
  status: "cancelled";
  cancelledSessionIds: string[];
}

export interface SubmitTaskResult {
  changeRequestId: string;
}

export interface RunTaskAgentResult {
  sessionId: string;
}

export interface RunIntegrationAgentResult {
  sessionId: string;
  integrationId: string;
  integrationStatus: string;
}

export interface RunProjectMergePlanAgentResult {
  runId: string;
  status: string;
}

export interface RunProjectValidationResult {
  runId: string;
  status: string;
}

export interface StartedWorkflowResult {
  workflowId: string;
  runId: string;
}

export interface StartIntegrationResult {
  integrationId: string;
}

export interface FinalizeIntegrationResult {
  integrationId: string;
  mainCommit: string;
  status: "merged";
}

export interface WorkflowActivities {
  provisionTaskWorkspaceActivity(input: TaskOperationInput): Promise<ProvisionTaskResult>;
  startTaskRunnerActivity(input: TaskOperationInput): Promise<StartRunnerResult>;
  cancelTaskActivity(input: TaskOperationInput): Promise<CancelTaskResult>;
  submitTaskChangeActivity(input: SubmitTaskInput): Promise<SubmitTaskResult>;
  runTaskAgentActivity(input: RunTaskAgentInput): Promise<RunTaskAgentResult>;
  runIntegrationAgentActivity(
    input: RunIntegrationAgentInput,
  ): Promise<RunIntegrationAgentResult>;
  runProjectMergePlanAgentActivity(
    input: RunProjectMergePlanAgentInput,
  ): Promise<RunProjectMergePlanAgentResult>;
  runProjectValidationActivity(
    input: RunProjectValidationInput,
  ): Promise<RunProjectValidationResult>;
  startIntegrationActivity(
    input: ChangeRequestOperationInput,
  ): Promise<StartIntegrationResult>;
  finalizeIntegrationActivity(
    input: FinalizeIntegrationInput,
  ): Promise<FinalizeIntegrationResult>;
  captureTaskWorkspaceProgressActivity(
    input: TaskWorkspaceMonitorInput,
  ): Promise<TaskWorkspaceMonitorCaptureResult>;
}
