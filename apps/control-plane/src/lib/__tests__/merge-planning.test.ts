import { describe, expect, it } from "vitest";

import type { TaskStatus } from "../domain";
import {
  buildProjectMergePlan,
  parseSemanticMergePlanSuggestion,
} from "../merge-planning";
import type { Task, TaskWorkspaceSnapshot } from "../types";

function task(
  id: string,
  status: TaskStatus,
  createdAt: number,
  expectedChangeScopes: string[] = [`src/${id}`],
): Task {
  return {
    id,
    projectId: "project-1",
    title: id,
    description: "",
    acceptanceCriteria: "",
    verificationCommands: [],
    expectedChangeScopes,
    status,
    baseBranch: "main",
    baseCommit: null,
    branchName: null,
    worktreePath: null,
    assignedUserId: "user-1",
    agentConnectionId: null,
    createdBy: "user-1",
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    assignedUserName: "Owner",
  };
}

function snapshot(taskId: string, input: Partial<TaskWorkspaceSnapshot>): TaskWorkspaceSnapshot {
  return {
    id: `snapshot-${taskId}`,
    taskId,
    observedBy: null,
    baseCommit: "base",
    headCommit: "head",
    mainCommit: "main",
    committedFiles: [],
    uncommittedFiles: [],
    actualChangedFiles: [],
    mainChangedFiles: [],
    overlappingFiles: [],
    structuralConflicts: [],
    mainCommitsSinceBase: 0,
    mainAdvanced: false,
    workingTreeClean: true,
    checkedAt: "2026-08-20T00:00:00.000Z",
    createdAt: "2026-08-20T00:00:00.000Z",
    ...input,
  };
}

describe("merge planning", () => {
  it("keeps prerequisites before dependents and prioritizes foundations", () => {
    const plan = buildProjectMergePlan({
      tasks: [task("foundation", "submitted", 1), task("dependent", "submitted", 2), task("docs", "submitted", 3)],
      dependencies: [
        {
          taskId: "dependent",
          dependsOnTaskId: "foundation",
          dependsOnTitle: "foundation",
          dependsOnStatus: "submitted",
          createdBy: "user-1",
          createdAt: new Date(4),
        },
      ],
      scopeConflicts: [],
      latestSnapshots: [],
      generatedAt: "2026-08-20T00:00:00.000Z",
    });

    expect(plan.items[0]?.taskId).toBe("foundation");
    expect(plan.items.findIndex((item) => item.taskId === "foundation")).toBeLessThan(
      plan.items.findIndex((item) => item.taskId === "dependent"),
    );
    expect(plan.items.find((item) => item.taskId === "dependent")?.readiness).toBe(
      "blocked_by_dependency",
    );
  });

  it("places invalid terminal dependencies behind actionable work", () => {
    const plan = buildProjectMergePlan({
      tasks: [task("ready", "submitted", 1), task("rejected", "rejected", 2), task("blocked", "submitted", 3)],
      dependencies: [
        {
          taskId: "blocked",
          dependsOnTaskId: "rejected",
          dependsOnTitle: "rejected",
          dependsOnStatus: "rejected",
          createdBy: "user-1",
          createdAt: new Date(4),
        },
      ],
      scopeConflicts: [],
      latestSnapshots: [],
    });

    expect(plan.items.map((item) => item.taskId)).toEqual(["ready", "blocked"]);
    expect(plan.items[1]?.blockingDependencies[0]?.status).toBe("rejected");
    expect(plan.items[1]?.requiresDependencyRepair).toBe(true);
  });

  it("raises risk for scope conflicts and real main overlap", () => {
    const plan = buildProjectMergePlan({
      tasks: [
        task("left", "submitted", 1, ["src/api"]),
        task("right", "submitted", 2, ["src/api/client"]),
      ],
      dependencies: [],
      scopeConflicts: [
        {
          leftTaskId: "left",
          leftTaskTitle: "left",
          rightTaskId: "right",
          rightTaskTitle: "right",
          overlaps: [{ leftScope: "src/api", rightScope: "src/api/client" }],
        },
      ],
      latestSnapshots: [
        snapshot("right", {
          overlappingFiles: ["src/api/client.ts"],
          mainAdvanced: true,
          mainCommitsSinceBase: 2,
        }),
      ],
    });

    expect(plan.items.find((item) => item.taskId === "left")?.riskLevel).toBe("medium");
    expect(plan.items.find((item) => item.taskId === "right")?.riskLevel).toBe("high");
    expect(plan.items.find((item) => item.taskId === "right")?.reasons).toContain(
      "Actual file overlap with latest main: src/api/client.ts",
    );
  });

  it("raises structural rename collisions to high risk", () => {
    const plan = buildProjectMergePlan({
      tasks: [task("rename", "submitted", 1)],
      dependencies: [],
      scopeConflicts: [],
      latestSnapshots: [
        snapshot("rename", {
          mainAdvanced: true,
          mainCommitsSinceBase: 1,
          structuralConflicts: [
            {
              kind: "rename_collision",
              severity: "danger",
              taskPath: "src/new.ts",
              mainPath: "src/old.ts",
              message: "rename collision",
            },
          ],
        }),
      ],
    });

    expect(plan.method).toBe("dependency-aware-risk-heuristic-v2");
    expect(plan.items[0]?.riskLevel).toBe("high");
    expect(plan.items[0]?.structuralConflicts).toHaveLength(1);
    expect(plan.items[0]?.reasons.some((reason) => reason.includes("structural relationship risks"))).toBe(true);
  });

  it("excludes terminal work and reports currently integrating work first", () => {
    const plan = buildProjectMergePlan({
      tasks: [task("merged", "merged", 1), task("active", "active", 2), task("integrating", "integrating", 3)],
      dependencies: [],
      scopeConflicts: [],
      latestSnapshots: [],
    });

    expect(plan.items.map((item) => item.taskId)).toEqual(["integrating", "active"]);
    expect(plan.items[0]?.readiness).toBe("integrating");
  });

  it("accepts a semantic reorder that preserves dependencies", () => {
    const tasks = [
      task("foundation", "submitted", 1),
      task("dependent", "submitted", 2),
      task("independent", "submitted", 3),
    ];
    const dependencies = [
      {
        taskId: "dependent",
        dependsOnTaskId: "foundation",
        dependsOnTitle: "foundation",
        dependsOnStatus: "submitted" as const,
        createdBy: "user-1",
        createdAt: new Date(4),
      },
    ];
    const baselinePlan = buildProjectMergePlan({
      tasks,
      dependencies,
      scopeConflicts: [],
      latestSnapshots: [],
    });

    const suggestion = parseSemanticMergePlanSuggestion({
      output: JSON.stringify({
        summary: "Move the independent task between the shared contract and its consumer.",
        recommendedTaskIds: ["independent", "foundation", "dependent"],
        orderRationale: [
          { taskId: "foundation", reason: "Defines the shared contract." },
          { taskId: "independent", reason: "Does not consume the contract." },
          { taskId: "dependent", reason: "Consumes the foundation contract." },
        ],
        semanticConflicts: [],
        uncertainties: [],
      }),
      baselinePlan,
      dependencies,
      validatedAt: "2026-08-20T00:00:00.000Z",
    });

    expect(suggestion.recommendedTaskIds).toEqual([
      "independent",
      "foundation",
      "dependent",
    ]);
    expect(suggestion.differsFromBaseline).toBe(true);
  });

  it("rejects semantic suggestions that violate dependency order", () => {
    const tasks = [task("foundation", "submitted", 1), task("dependent", "submitted", 2)];
    const dependencies = [
      {
        taskId: "dependent",
        dependsOnTaskId: "foundation",
        dependsOnTitle: "foundation",
        dependsOnStatus: "submitted" as const,
        createdBy: "user-1",
        createdAt: new Date(3),
      },
    ];
    const baselinePlan = buildProjectMergePlan({
      tasks,
      dependencies,
      scopeConflicts: [],
      latestSnapshots: [],
    });

    expect(() => parseSemanticMergePlanSuggestion({
      output: JSON.stringify({
        summary: "Invalid order.",
        recommendedTaskIds: ["dependent", "foundation"],
        orderRationale: [],
        semanticConflicts: [],
        uncertainties: [],
      }),
      baselinePlan,
      dependencies,
    })).toThrowError(/violated dependency order/);
  });
});
