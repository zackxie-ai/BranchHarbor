import { Context } from "@temporalio/activity";

import {
  cancelTask,
  captureTaskWorkspaceProgressForMonitor,
  finalizeIntegration,
  provisionTaskWorkspace,
  runTaskAgent,
  runIntegrationAgent,
  runProjectMergePlanAgent,
  runProjectValidation,
  startIntegration,
  startTaskRunner,
  submitTaskChange,
} from "../lib/services";
import {
  completeWorkflowExecution,
  failWorkflowExecution,
  insertWorkflowExecution,
} from "../lib/repositories";
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
  WorkflowActivities,
} from "./contracts";

async function withWorkflowTracking<Result>(input: {
  actorId: string;
  entityType: string;
  entityId: string;
  run: () => Promise<Result>;
}): Promise<Result> {
  const info = Context.current().info;
  const activityContext = Context.current();
  const execution = info.workflowExecution;
  if (!execution) {
    return input.run();
  }

  await insertWorkflowExecution({
    workflowId: execution.workflowId,
    runId: execution.runId,
    workflowType: info.workflowType ?? "unknown",
    entityType: input.entityType,
    entityId: input.entityId,
    actorId: input.actorId,
  });

  activityContext.heartbeat({ entityType: input.entityType, entityId: input.entityId });
  const heartbeatTimer = setInterval(() => {
    activityContext.heartbeat({ entityType: input.entityType, entityId: input.entityId });
  }, 15_000);

  try {
    const result = await input.run();
    await completeWorkflowExecution({
      workflowId: execution.workflowId,
      runId: execution.runId,
      result,
    });
    return result;
  } catch (error) {
    await failWorkflowExecution({
      workflowId: execution.workflowId,
      runId: execution.runId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export const activities: WorkflowActivities = {
  async captureTaskWorkspaceProgressActivity(input: TaskWorkspaceMonitorInput) {
    Context.current().heartbeat({ taskId: input.taskId, operation: "workspace-progress" });
    return captureTaskWorkspaceProgressForMonitor(input.taskId);
  },

  async provisionTaskWorkspaceActivity(input: TaskOperationInput) {
    return withWorkflowTracking({
      actorId: input.actorId,
      entityType: "task",
      entityId: input.taskId,
      run: async () => {
        const result = await provisionTaskWorkspace(input.taskId, input.actorId);
        return { taskId: result.task.id, runnerId: result.runner.id };
      },
    });
  },

  async startTaskRunnerActivity(input: TaskOperationInput) {
    return withWorkflowTracking({
      actorId: input.actorId,
      entityType: "task",
      entityId: input.taskId,
      run: async () => {
        const runner = await startTaskRunner(input.taskId, input.actorId);
        return { runnerId: runner.id };
      },
    });
  },

  async cancelTaskActivity(input: TaskOperationInput) {
    return withWorkflowTracking({
      actorId: input.actorId,
      entityType: "task",
      entityId: input.taskId,
      run: () => cancelTask(input.taskId, input.actorId),
    });
  },

  async submitTaskChangeActivity(input: SubmitTaskInput) {
    return withWorkflowTracking({
      actorId: input.actorId,
      entityType: "task",
      entityId: input.taskId,
      run: async () => {
        const changeRequest = await submitTaskChange(
          input.taskId,
          { summary: input.summary, risks: input.risks },
          input.actorId,
        );
        return { changeRequestId: changeRequest.id };
      },
    });
  },

  async runTaskAgentActivity(input: RunTaskAgentInput) {
    return withWorkflowTracking({
      actorId: input.actorId,
      entityType: "task",
      entityId: input.taskId,
      run: async () => {
        const session = await runTaskAgent(
          input.taskId,
          { prompt: input.prompt, resumeSessionId: input.resumeSessionId },
          input.actorId,
        );
        return { sessionId: session.id };
      },
    });
  },

  async runIntegrationAgentActivity(input: RunIntegrationAgentInput) {
    return withWorkflowTracking({
      actorId: input.actorId,
      entityType: "integration",
      entityId: input.integrationId,
      run: async () => {
        const result = await runIntegrationAgent(
          input.integrationId,
          {
            agentConnectionId: input.agentConnectionId,
            prompt: input.prompt,
            resumeSessionId: input.resumeSessionId,
          },
          input.actorId,
        );
        return {
          sessionId: result.session.id,
          integrationId: result.integration.id,
          integrationStatus: result.integration.status,
        };
      },
    });
  },

  async runProjectMergePlanAgentActivity(input: RunProjectMergePlanAgentInput) {
    return withWorkflowTracking({
      actorId: input.actorId,
      entityType: "project_merge_plan_agent_run",
      entityId: input.runId,
      run: async () => {
        const result = await runProjectMergePlanAgent(input.runId, input.actorId);
        return { runId: result.id, status: result.status };
      },
    });
  },

  async runProjectValidationActivity(input: RunProjectValidationInput) {
    return withWorkflowTracking({
      actorId: input.actorId,
      entityType: "project_validation_run",
      entityId: input.runId,
      run: async () => {
        const result = await runProjectValidation(input.runId, input.actorId);
        return { runId: result.id, status: result.status };
      },
    });
  },

  async startIntegrationActivity(input: ChangeRequestOperationInput) {
    return withWorkflowTracking({
      actorId: input.actorId,
      entityType: "change_request",
      entityId: input.changeRequestId,
      run: async () => {
        const integration = await startIntegration(input.changeRequestId, input.actorId);
        return { integrationId: integration.id };
      },
    });
  },

  async finalizeIntegrationActivity(input: FinalizeIntegrationInput) {
    return withWorkflowTracking({
      actorId: input.actorId,
      entityType: "integration",
      entityId: input.integrationId,
      run: () =>
        finalizeIntegration(
          input.integrationId,
          { comment: input.comment },
          input.actorId,
        ),
    });
  },
};
