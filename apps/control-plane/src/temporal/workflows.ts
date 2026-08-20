import {
  continueAsNew,
  ParentClosePolicy,
  proxyActivities,
  sleep,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";

import type {
  ChangeRequestOperationInput,
  FinalizeIntegrationInput,
  RunTaskAgentInput,
  RunIntegrationAgentInput,
  RunProjectMergePlanAgentInput,
  RunProjectValidationInput,
  SubmitTaskInput,
  TaskOperationInput,
  TaskWorkspaceMonitorInput,
  TaskWorkspaceMonitorResult,
  WorkflowActivities,
} from "./contracts";

const standardActivities = proxyActivities<WorkflowActivities>({
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout: "1 minute",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["AppError", "ZodError"],
  },
});

const integrationActivities = proxyActivities<WorkflowActivities>({
  startToCloseTimeout: "45 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["AppError", "ZodError"],
  },
});

const agentActivities = proxyActivities<WorkflowActivities>({
  startToCloseTimeout: "2 hours",
  heartbeatTimeout: "1 minute",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 2,
    nonRetryableErrorTypes: ["AppError", "ZodError"],
  },
});

const monitorActivities = proxyActivities<WorkflowActivities>({
  startToCloseTimeout: "2 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 5,
    nonRetryableErrorTypes: ["ZodError"],
  },
});

export async function provisionTaskWorkspaceWorkflow(input: TaskOperationInput) {
  const result = await standardActivities.provisionTaskWorkspaceActivity(input);
  await startChild(taskWorkspaceMonitorWorkflow, {
    workflowId: `cloudagent-task-workspace-monitor-${input.taskId}`,
    args: [{ taskId: input.taskId, actorId: input.actorId }],
    parentClosePolicy: ParentClosePolicy.ABANDON,
    workflowIdReusePolicy: "REJECT_DUPLICATE",
  });
  return result;
}

export async function taskWorkspaceMonitorWorkflow(
  input: TaskWorkspaceMonitorInput,
): Promise<TaskWorkspaceMonitorResult> {
  const maxChecksPerRun = Math.min(Math.max(input.maxChecksPerRun ?? 120, 1), 1_000);
  const pollIntervalMs = Math.min(Math.max(input.pollIntervalMs ?? 10_000, 250), 300_000);
  let checks = 0;
  let snapshotsCreated = 0;
  while (checks < maxChecksPerRun) {
    const result = await monitorActivities.captureTaskWorkspaceProgressActivity(input);
    checks += 1;
    if (result.snapshotCreated) snapshotsCreated += 1;
    if (!result.continueMonitoring) {
      return {
        taskId: input.taskId,
        status: "stopped",
        reason: result.reason,
        checks,
        snapshotsCreated,
      };
    }
    await sleep(pollIntervalMs);
    if (workflowInfo().continueAsNewSuggested) break;
  }
  return continueAsNew<typeof taskWorkspaceMonitorWorkflow>({
    ...input,
    generation: (input.generation ?? 0) + 1,
  });
}

export async function startTaskRunnerWorkflow(input: TaskOperationInput) {
  return standardActivities.startTaskRunnerActivity(input);
}

export async function cancelTaskWorkflow(input: TaskOperationInput) {
  return standardActivities.cancelTaskActivity(input);
}

export async function submitTaskChangeWorkflow(input: SubmitTaskInput) {
  return standardActivities.submitTaskChangeActivity(input);
}

export async function runTaskAgentWorkflow(input: RunTaskAgentInput) {
  return agentActivities.runTaskAgentActivity(input);
}

export async function runIntegrationAgentWorkflow(input: RunIntegrationAgentInput) {
  return agentActivities.runIntegrationAgentActivity(input);
}

export async function runProjectMergePlanAgentWorkflow(input: RunProjectMergePlanAgentInput) {
  return agentActivities.runProjectMergePlanAgentActivity(input);
}

export async function runProjectValidationWorkflow(input: RunProjectValidationInput) {
  return integrationActivities.runProjectValidationActivity(input);
}

export async function startIntegrationWorkflow(input: ChangeRequestOperationInput) {
  return integrationActivities.startIntegrationActivity(input);
}

export async function finalizeIntegrationWorkflow(input: FinalizeIntegrationInput) {
  return integrationActivities.finalizeIntegrationActivity(input);
}
