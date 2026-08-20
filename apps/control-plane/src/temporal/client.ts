import { randomUUID } from "node:crypto";

import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";

import { config } from "../lib/config";
import {
  completeWorkflowExecution,
  failWorkflowExecution,
  insertWorkflowExecution,
} from "../lib/repositories";
import type {
  ChangeRequestOperationInput,
  CancelTaskResult,
  FinalizeIntegrationInput,
  FinalizeIntegrationResult,
  ProvisionTaskResult,
  RunTaskAgentInput,
  RunIntegrationAgentInput,
  RunProjectMergePlanAgentInput,
  RunProjectValidationInput,
  StartedWorkflowResult,
  StartIntegrationResult,
  StartRunnerResult,
  SubmitTaskInput,
  SubmitTaskResult,
  TaskOperationInput,
} from "./contracts";

declare global {
  var cloudAgentTemporalClientPromise: Promise<Client> | undefined;
}

async function createTemporalClient(): Promise<Client> {
  const connection = await Connection.connect({
    address: config.temporal.address,
    channelArgs: config.temporal.disableHttpProxy
      ? { "grpc.enable_http_proxy": 0 }
      : undefined,
  });
  return new Client({ connection, namespace: config.temporal.namespace });
}

function getTemporalClient(): Promise<Client> {
  if (!global.cloudAgentTemporalClientPromise) {
    global.cloudAgentTemporalClientPromise = createTemporalClient().catch((error) => {
      global.cloudAgentTemporalClientPromise = undefined;
      throw error;
    });
  }
  return global.cloudAgentTemporalClientPromise;
}

async function executeWorkflow<Result>(input: {
  workflowType: string;
  workflowId: string;
  args: unknown[];
  entityType: string;
  entityId: string;
  actorId: string;
  oneTime?: boolean;
}): Promise<Result> {
  const client = await getTemporalClient();
  let handle;
  try {
    handle = await client.workflow.start(input.workflowType, {
      taskQueue: config.temporal.taskQueue,
      workflowId: input.workflowId,
      args: input.args,
      workflowExecutionTimeout: "2 hours",
      workflowTaskTimeout: "10 seconds",
      workflowIdConflictPolicy: "USE_EXISTING",
      workflowIdReusePolicy: input.oneTime ? "REJECT_DUPLICATE" : "ALLOW_DUPLICATE",
    });
  } catch (error) {
    if (input.oneTime && error instanceof WorkflowExecutionAlreadyStartedError) {
      return (await client.workflow.getHandle(input.workflowId).result()) as Result;
    }
    throw error;
  }
  const runId = handle.firstExecutionRunId;
  await insertWorkflowExecution({
    workflowId: handle.workflowId,
    runId,
    workflowType: input.workflowType,
    entityType: input.entityType,
    entityId: input.entityId,
    actorId: input.actorId,
  });

  try {
    const result = (await handle.result()) as Result;
    await completeWorkflowExecution({ workflowId: handle.workflowId, runId, result });
    return result;
  } catch (error) {
    await failWorkflowExecution({
      workflowId: handle.workflowId,
      runId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function startWorkflow(input: {
  workflowType: string;
  workflowId: string;
  args: unknown[];
  entityType: string;
  entityId: string;
  actorId: string;
}): Promise<StartedWorkflowResult> {
  const client = await getTemporalClient();
  const handle = await client.workflow.start(input.workflowType, {
    taskQueue: config.temporal.taskQueue,
    workflowId: input.workflowId,
    args: input.args,
    workflowExecutionTimeout: "3 hours",
    workflowTaskTimeout: "10 seconds",
    workflowIdConflictPolicy: "FAIL",
    workflowIdReusePolicy: "ALLOW_DUPLICATE",
  });
  const result = {
    workflowId: handle.workflowId,
    runId: handle.firstExecutionRunId,
  };
  await insertWorkflowExecution({
    ...result,
    workflowType: input.workflowType,
    entityType: input.entityType,
    entityId: input.entityId,
    actorId: input.actorId,
  });
  return result;
}

export function durableProvisionTaskWorkspace(
  input: TaskOperationInput,
): Promise<ProvisionTaskResult> {
  return executeWorkflow({
    workflowType: "provisionTaskWorkspaceWorkflow",
    workflowId: `cloudagent-task-workspace-${input.taskId}`,
    args: [input],
    entityType: "task",
    entityId: input.taskId,
    actorId: input.actorId,
    oneTime: true,
  });
}

export function durableStartTaskRunner(input: TaskOperationInput): Promise<StartRunnerResult> {
  return executeWorkflow({
    workflowType: "startTaskRunnerWorkflow",
    workflowId: `cloudagent-task-runner-${input.taskId}-${randomUUID()}`,
    args: [input],
    entityType: "task",
    entityId: input.taskId,
    actorId: input.actorId,
    oneTime: true,
  });
}

export function durableCancelTask(input: TaskOperationInput): Promise<CancelTaskResult> {
  return executeWorkflow({
    workflowType: "cancelTaskWorkflow",
    workflowId: `cloudagent-task-cancel-${input.taskId}`,
    args: [input],
    entityType: "task",
    entityId: input.taskId,
    actorId: input.actorId,
    oneTime: true,
  });
}

export function durableSubmitTaskChange(input: SubmitTaskInput): Promise<SubmitTaskResult> {
  return executeWorkflow({
    workflowType: "submitTaskChangeWorkflow",
    workflowId: `cloudagent-task-submit-${input.taskId}-${randomUUID()}`,
    args: [input],
    entityType: "task",
    entityId: input.taskId,
    actorId: input.actorId,
  });
}

export function durableRunTaskAgent(
  input: RunTaskAgentInput,
): Promise<StartedWorkflowResult> {
  return startWorkflow({
    workflowType: "runTaskAgentWorkflow",
    workflowId: `cloudagent-agent-${input.taskId}-${randomUUID()}`,
    args: [input],
    entityType: "task",
    entityId: input.taskId,
    actorId: input.actorId,
  });
}

export function durableRunIntegrationAgent(
  input: RunIntegrationAgentInput,
): Promise<StartedWorkflowResult> {
  return startWorkflow({
    workflowType: "runIntegrationAgentWorkflow",
    workflowId: `cloudagent-integration-agent-${input.integrationId}-${randomUUID()}`,
    args: [input],
    entityType: "integration",
    entityId: input.integrationId,
    actorId: input.actorId,
  });
}

export function durableRunProjectMergePlanAgent(
  input: RunProjectMergePlanAgentInput,
): Promise<StartedWorkflowResult> {
  return startWorkflow({
    workflowType: "runProjectMergePlanAgentWorkflow",
    workflowId: `cloudagent-merge-plan-agent-${input.runId}`,
    args: [input],
    entityType: "project_merge_plan_agent_run",
    entityId: input.runId,
    actorId: input.actorId,
  });
}

export function durableRunProjectValidation(
  input: RunProjectValidationInput,
): Promise<StartedWorkflowResult> {
  return startWorkflow({
    workflowType: "runProjectValidationWorkflow",
    workflowId: `cloudagent-project-validation-${input.runId}`,
    args: [input],
    entityType: "project_validation_run",
    entityId: input.runId,
    actorId: input.actorId,
  });
}

export function durableStartIntegration(
  input: ChangeRequestOperationInput,
): Promise<StartIntegrationResult> {
  return executeWorkflow({
    workflowType: "startIntegrationWorkflow",
    workflowId: `cloudagent-integration-${input.changeRequestId}`,
    args: [input],
    entityType: "change_request",
    entityId: input.changeRequestId,
    actorId: input.actorId,
    oneTime: true,
  });
}

export function durableFinalizeIntegration(
  input: FinalizeIntegrationInput,
): Promise<FinalizeIntegrationResult> {
  return executeWorkflow({
    workflowType: "finalizeIntegrationWorkflow",
    workflowId: `cloudagent-finalize-${input.integrationId}`,
    args: [input],
    entityType: "integration",
    entityId: input.integrationId,
    actorId: input.actorId,
    oneTime: true,
  });
}
