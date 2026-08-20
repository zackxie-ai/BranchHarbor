import { describe, expect, it } from "vitest";

import {
  buildIntegrationQueueGate,
  buildIntegrationQueueTaskOrder,
} from "../integration-queue";
import type { ProjectIntegrationQueue } from "../integration-queue";
import type {
  ProjectMergePlan,
  ProjectMergePlanAgentRun,
} from "../merge-planning";

function plan(): ProjectMergePlan {
  return {
    method: "dependency-aware-risk-heuristic-v2",
    generatedAt: "2026-08-20T00:00:00.000Z",
    hasDependencyCycle: false,
    readyTaskIds: ["foundation", "docs", "consumer"],
    items: ["foundation", "docs", "consumer"].map((taskId, index) => ({
      position: index + 1,
      taskId,
      title: taskId,
      status: "submitted",
      readiness: "ready",
      riskLevel: "low",
      assignedUserName: null,
      blockingDependencies: [],
      conflictTaskIds: [],
      actualOverlappingFiles: [],
      structuralConflicts: [],
      mainAdvanced: false,
      workingTreeClean: true,
      directDependentCount: 0,
      requiresDependencyRepair: false,
      reasons: [],
    })),
  };
}

function semanticRun(): ProjectMergePlanAgentRun {
  return {
    id: "semantic-run",
    projectId: "project",
    agentConnectionId: "agent",
    status: "completed",
    instruction: "Analyze merge order",
    baselinePlan: plan(),
    dependencies: [],
    analysisPrompt: "prompt",
    suggestion: {
      summary: "Move docs first.",
      recommendedTaskIds: ["docs", "foundation", "consumer"],
      orderRationale: [],
      semanticConflicts: [],
      uncertainties: [],
      differsFromBaseline: true,
      validatedAt: "2026-08-20T00:00:00.000Z",
    },
    rawResponse: null,
    errorMessage: null,
    createdBy: "admin",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("integration queue ordering", () => {
  it("keeps the deterministic order for the selected subset", () => {
    expect(buildIntegrationQueueTaskOrder({
      source: "deterministic",
      selectedTaskIds: ["consumer", "foundation"],
      mergePlan: plan(),
      semanticRun: null,
    })).toEqual(["foundation", "consumer"]);
  });

  it("adopts a validated semantic order for the selected subset", () => {
    expect(buildIntegrationQueueTaskOrder({
      source: "semantic",
      selectedTaskIds: ["consumer", "docs", "foundation"],
      mergePlan: plan(),
      semanticRun: semanticRun(),
    })).toEqual(["docs", "foundation", "consumer"]);
  });

  it("rejects tasks that are not currently ready", () => {
    expect(() => buildIntegrationQueueTaskOrder({
      source: "deterministic",
      selectedTaskIds: ["blocked"],
      mergePlan: plan(),
      semanticRun: null,
    })).toThrowError(/currently be ready/);
  });
});

function queue(statuses: Array<"submitted" | "merged" | "rejected">): ProjectIntegrationQueue {
  return {
    id: "queue",
    projectId: "project",
    status: "active",
    source: "deterministic",
    sourceMergePlanRunId: null,
    createdBy: "admin",
    cancelledBy: null,
    cancellationReason: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    cancelledAt: null,
    completedAt: null,
    items: statuses.map((status, index) => ({
      position: index + 1,
      taskId: `task-${index + 1}`,
      taskTitle: `Task ${index + 1}`,
      taskStatus: status === "merged" ? "merged" : status === "rejected" ? "rejected" : "submitted",
      changeRequestId: `change-${index + 1}`,
      changeRequestStatus: status,
      headCommit: `commit-${index + 1}`,
    })),
  };
}

describe("integration queue gate", () => {
  it("blocks later work until every earlier item is terminal", () => {
    const gate = buildIntegrationQueueGate(queue(["submitted", "submitted"]), "change-2");
    expect(gate.allowed).toBe(false);
    expect(gate.blockingItems.map((item) => item.taskId)).toEqual(["task-1"]);
  });

  it("unlocks the next item after an earlier rejection", () => {
    expect(buildIntegrationQueueGate(queue(["rejected", "submitted"]), "change-2").allowed).toBe(true);
  });

  it("rejects Change Requests outside an active queue", () => {
    const gate = buildIntegrationQueueGate(queue(["submitted"]), "outside");
    expect(gate.allowed).toBe(false);
    expect(gate.queued).toBe(false);
  });
});
