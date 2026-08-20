import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedActivities = vi.hoisted(() => ({
  provisionTaskWorkspaceActivity: vi.fn(),
  startTaskRunnerActivity: vi.fn(),
  cancelTaskActivity: vi.fn(),
  submitTaskChangeActivity: vi.fn(),
  startIntegrationActivity: vi.fn(),
  finalizeIntegrationActivity: vi.fn(),
  captureTaskWorkspaceProgressActivity: vi.fn(),
}));

const mockedWorkflow = vi.hoisted(() => ({
  continueAsNew: vi.fn(),
  sleep: vi.fn(),
  startChild: vi.fn(),
  workflowInfo: vi.fn(() => ({ continueAsNewSuggested: false })),
}));

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => mockedActivities,
  continueAsNew: mockedWorkflow.continueAsNew,
  ParentClosePolicy: { ABANDON: "ABANDON" },
  sleep: mockedWorkflow.sleep,
  startChild: mockedWorkflow.startChild,
  workflowInfo: mockedWorkflow.workflowInfo,
}));

import {
  finalizeIntegrationWorkflow,
  cancelTaskWorkflow,
  provisionTaskWorkspaceWorkflow,
  startIntegrationWorkflow,
  startTaskRunnerWorkflow,
  submitTaskChangeWorkflow,
  taskWorkspaceMonitorWorkflow,
} from "../workflows";

describe("BranchHarbor Temporal workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedWorkflow.startChild.mockResolvedValue({});
    mockedWorkflow.sleep.mockResolvedValue(undefined);
    mockedWorkflow.continueAsNew.mockResolvedValue(undefined);
    mockedWorkflow.workflowInfo.mockReturnValue({ continueAsNewSuggested: false });
  });

  it("delegates task lifecycle operations to retryable activities", async () => {
    const taskInput = { taskId: "task-1", actorId: "user-1" };
    mockedActivities.provisionTaskWorkspaceActivity.mockResolvedValue({
      taskId: "task-1",
      runnerId: "runner-1",
    });
    mockedActivities.startTaskRunnerActivity.mockResolvedValue({ runnerId: "runner-1" });
    mockedActivities.cancelTaskActivity.mockResolvedValue({
      taskId: "task-1",
      status: "cancelled",
      cancelledSessionIds: ["session-1"],
    });
    mockedActivities.submitTaskChangeActivity.mockResolvedValue({ changeRequestId: "change-1" });

    await expect(provisionTaskWorkspaceWorkflow(taskInput)).resolves.toEqual({
      taskId: "task-1",
      runnerId: "runner-1",
    });
    expect(mockedWorkflow.startChild).toHaveBeenCalledWith(
      taskWorkspaceMonitorWorkflow,
      expect.objectContaining({
        workflowId: "branchharbor-task-workspace-monitor-task-1",
        parentClosePolicy: "ABANDON",
      }),
    );
    await expect(startTaskRunnerWorkflow(taskInput)).resolves.toEqual({ runnerId: "runner-1" });
    await expect(cancelTaskWorkflow(taskInput)).resolves.toEqual({
      taskId: "task-1",
      status: "cancelled",
      cancelledSessionIds: ["session-1"],
    });
    await expect(
      submitTaskChangeWorkflow({ ...taskInput, summary: "Implemented", risks: [] }),
    ).resolves.toEqual({ changeRequestId: "change-1" });
  });

  it("keeps capturing workspace progress until the task no longer needs monitoring", async () => {
    mockedActivities.captureTaskWorkspaceProgressActivity
      .mockResolvedValueOnce({
        continueMonitoring: true,
        snapshotCreated: true,
        reason: "snapshot_created",
        errorMessage: null,
      })
      .mockResolvedValueOnce({
        continueMonitoring: false,
        snapshotCreated: false,
        reason: "task_merged",
        errorMessage: null,
      });

    await expect(
      taskWorkspaceMonitorWorkflow({
        taskId: "task-1",
        actorId: "user-1",
        pollIntervalMs: 250,
      }),
    ).resolves.toEqual({
      taskId: "task-1",
      status: "stopped",
      reason: "task_merged",
      checks: 2,
      snapshotsCreated: 1,
    });
    expect(mockedWorkflow.sleep).toHaveBeenCalledTimes(1);
    expect(mockedWorkflow.sleep).toHaveBeenCalledWith(250);
  });

  it("continues workspace monitoring as new to bound workflow history", async () => {
    mockedActivities.captureTaskWorkspaceProgressActivity.mockResolvedValue({
      continueMonitoring: true,
      snapshotCreated: false,
      reason: "state_unchanged",
      errorMessage: null,
    });

    await taskWorkspaceMonitorWorkflow({
      taskId: "task-1",
      actorId: "user-1",
      generation: 2,
      maxChecksPerRun: 1,
      pollIntervalMs: 250,
    });
    expect(mockedWorkflow.continueAsNew).toHaveBeenCalledWith({
      taskId: "task-1",
      actorId: "user-1",
      generation: 3,
      maxChecksPerRun: 1,
      pollIntervalMs: 250,
    });
  });

  it("keeps integration and final main updates inside durable activities", async () => {
    mockedActivities.startIntegrationActivity.mockResolvedValue({ integrationId: "integration-1" });
    mockedActivities.finalizeIntegrationActivity.mockResolvedValue({
      integrationId: "integration-1",
      mainCommit: "abc123",
      status: "merged",
    });

    await expect(
      startIntegrationWorkflow({ changeRequestId: "change-1", actorId: "admin-1" }),
    ).resolves.toEqual({ integrationId: "integration-1" });
    await expect(
      finalizeIntegrationWorkflow({ integrationId: "integration-1", actorId: "admin-1" }),
    ).resolves.toEqual({
      integrationId: "integration-1",
      mainCommit: "abc123",
      status: "merged",
    });
  });
});
