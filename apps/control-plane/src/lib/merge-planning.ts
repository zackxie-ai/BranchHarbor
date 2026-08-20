import type { TaskStatus } from "./domain";
import { AppError } from "./errors";
import type {
  ChangeRequest,
  Task,
  TaskDependency,
  TaskScopeConflict,
  TaskWorkspaceSnapshot,
} from "./types";
import { z } from "zod";

export type MergePlanReadiness =
  | "integrating"
  | "ready"
  | "changes_requested"
  | "waiting_for_submission"
  | "blocked_by_dependency";

export type MergePlanRiskLevel = "low" | "medium" | "high";

export interface MergePlanDependency {
  taskId: string;
  title: string;
  status: TaskStatus;
}

export interface ProjectMergePlanItem {
  position: number;
  taskId: string;
  title: string;
  status: TaskStatus;
  readiness: MergePlanReadiness;
  riskLevel: MergePlanRiskLevel;
  assignedUserName: string | null;
  blockingDependencies: MergePlanDependency[];
  conflictTaskIds: string[];
  actualOverlappingFiles: string[];
  structuralConflicts: TaskWorkspaceSnapshot["structuralConflicts"];
  mainAdvanced: boolean;
  workingTreeClean: boolean | null;
  directDependentCount: number;
  requiresDependencyRepair: boolean;
  reasons: string[];
}

export interface ProjectMergePlan {
  method: "dependency-aware-risk-heuristic-v2";
  generatedAt: string;
  hasDependencyCycle: boolean;
  readyTaskIds: string[];
  items: ProjectMergePlanItem[];
}

export interface SemanticMergePlanConflict {
  taskIds: string[];
  severity: "warning" | "danger";
  summary: string;
  evidence: string[];
  recommendation: string;
}

export interface SemanticMergePlanSuggestion {
  summary: string;
  recommendedTaskIds: string[];
  orderRationale: Array<{ taskId: string; reason: string }>;
  semanticConflicts: SemanticMergePlanConflict[];
  uncertainties: string[];
  differsFromBaseline: boolean;
  validatedAt: string;
}

export interface ProjectMergePlanAgentRun {
  id: string;
  projectId: string;
  agentConnectionId: string;
  agentDisplayName?: string | null;
  sessionId?: string | null;
  status: "starting" | "running" | "completed" | "invalid" | "failed" | "cancelled";
  instruction: string;
  baselinePlan: ProjectMergePlan;
  dependencies: TaskDependency[];
  analysisPrompt: string;
  suggestion: SemanticMergePlanSuggestion | null;
  rawResponse: string | null;
  errorMessage: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const semanticMergePlanSuggestionSchema = z.object({
  summary: z.string().trim().min(1).max(5_000),
  recommendedTaskIds: z.array(z.string().min(1)).max(200),
  orderRationale: z.array(z.object({
    taskId: z.string().min(1),
    reason: z.string().trim().min(1).max(2_000),
  })).max(200),
  semanticConflicts: z.array(z.object({
    taskIds: z.array(z.string().min(1)).min(2).max(20),
    severity: z.enum(["warning", "danger"]),
    summary: z.string().trim().min(1).max(2_000),
    evidence: z.array(z.string().trim().min(1).max(2_000)).max(20),
    recommendation: z.string().trim().min(1).max(2_000),
  })).max(100),
  uncertainties: z.array(z.string().trim().min(1).max(2_000)).max(100),
});

function extractJsonObject(output: string): unknown {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // The structured error below is more useful than the JSON parser exception.
      }
    }
  }
  throw new AppError(
    "Merge Planning Agent did not return a valid JSON object",
    422,
    "MERGE_PLAN_AGENT_INVALID_JSON",
  );
}

export function parseSemanticMergePlanSuggestion(input: {
  output: string;
  baselinePlan: ProjectMergePlan;
  dependencies: TaskDependency[];
  validatedAt?: string;
}): SemanticMergePlanSuggestion {
  const parsed = semanticMergePlanSuggestionSchema.parse(extractJsonObject(input.output));
  const expectedTaskIds = input.baselinePlan.items.map((item) => item.taskId);
  const expectedTaskIdSet = new Set(expectedTaskIds);
  const recommendedTaskIdSet = new Set(parsed.recommendedTaskIds);
  if (
    recommendedTaskIdSet.size !== parsed.recommendedTaskIds.length ||
    parsed.recommendedTaskIds.length !== expectedTaskIds.length ||
    expectedTaskIds.some((taskId) => !recommendedTaskIdSet.has(taskId))
  ) {
    throw new AppError(
      "Merge Planning Agent must include every active task exactly once",
      422,
      "MERGE_PLAN_AGENT_TASK_SET_INVALID",
    );
  }

  const positionByTaskId = new Map(
    parsed.recommendedTaskIds.map((taskId, index) => [taskId, index]),
  );
  for (const dependency of input.dependencies) {
    const taskPosition = positionByTaskId.get(dependency.taskId);
    const prerequisitePosition = positionByTaskId.get(dependency.dependsOnTaskId);
    if (
      taskPosition !== undefined &&
      prerequisitePosition !== undefined &&
      prerequisitePosition >= taskPosition
    ) {
      throw new AppError(
        `Merge Planning Agent violated dependency order for ${dependency.taskId}`,
        422,
        "MERGE_PLAN_AGENT_DEPENDENCY_ORDER_INVALID",
      );
    }
  }

  const integratingIds = new Set(
    input.baselinePlan.items
      .filter((item) => item.readiness === "integrating")
      .map((item) => item.taskId),
  );
  if (integratingIds.size > 0) {
    const lastIntegratingPosition = Math.max(
      ...[...integratingIds].map((taskId) => positionByTaskId.get(taskId) ?? -1),
    );
    const firstNonIntegratingPosition = Math.min(
      ...parsed.recommendedTaskIds
        .filter((taskId) => !integratingIds.has(taskId))
        .map((taskId) => positionByTaskId.get(taskId) ?? Number.POSITIVE_INFINITY),
    );
    if (lastIntegratingPosition > firstNonIntegratingPosition) {
      throw new AppError(
        "Tasks already integrating must remain ahead of other tasks",
        422,
        "MERGE_PLAN_AGENT_INTEGRATING_ORDER_INVALID",
      );
    }
  }

  for (const rationale of parsed.orderRationale) {
    if (!expectedTaskIdSet.has(rationale.taskId)) {
      throw new AppError(
        "Merge Planning Agent rationale referenced an unknown task",
        422,
        "MERGE_PLAN_AGENT_UNKNOWN_TASK",
      );
    }
  }
  for (const conflict of parsed.semanticConflicts) {
    if (
      new Set(conflict.taskIds).size !== conflict.taskIds.length ||
      conflict.taskIds.some((taskId) => !expectedTaskIdSet.has(taskId))
    ) {
      throw new AppError(
        "Merge Planning Agent conflict referenced invalid tasks",
        422,
        "MERGE_PLAN_AGENT_CONFLICT_TASK_INVALID",
      );
    }
  }

  return {
    ...parsed,
    differsFromBaseline: parsed.recommendedTaskIds.some(
      (taskId, index) => taskId !== expectedTaskIds[index],
    ),
    validatedAt: input.validatedAt ?? new Date().toISOString(),
  };
}

export function buildSemanticMergePlanPrompt(input: {
  projectName: string;
  instruction: string;
  baselinePlan: ProjectMergePlan;
  tasks: Task[];
  dependencies: TaskDependency[];
  changeRequests: ChangeRequest[];
}): string {
  const changeRequestByTaskId = new Map(
    input.changeRequests.map((changeRequest) => [changeRequest.taskId, changeRequest]),
  );
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const payload = input.baselinePlan.items.map((item) => {
    const task = taskById.get(item.taskId);
    const changeRequest = changeRequestByTaskId.get(item.taskId);
    return {
      baselinePosition: item.position,
      taskId: item.taskId,
      title: item.title,
      description: task?.description ?? "",
      acceptanceCriteria: task?.acceptanceCriteria ?? "",
      expectedChangeScopes: task?.expectedChangeScopes ?? [],
      status: item.status,
      readiness: item.readiness,
      riskLevel: item.riskLevel,
      assignedUserName: item.assignedUserName,
      blockingDependencies: item.blockingDependencies,
      directDependentCount: item.directDependentCount,
      ruleReasons: item.reasons,
      actualOverlappingFiles: item.actualOverlappingFiles,
      structuralConflicts: item.structuralConflicts,
      changeRequest: changeRequest
        ? {
            summary: changeRequest.summary,
            baseCommit: changeRequest.baseCommit,
            headCommit: changeRequest.headCommit,
            changedFiles: changeRequest.changedFiles,
            diffStat: changeRequest.diffStat,
            risks: changeRequest.risks,
            verificationResults: changeRequest.verificationResults.map((result) => ({
              command: result.command,
              exitCode: result.exitCode,
            })),
          }
        : null,
    };
  });

  return [
    "You are the BranchHarbor Admin Merge Planning Agent.",
    `Project: ${input.projectName}`,
    "Your job is analysis only. The mounted project workspace is read-only.",
    "Do not modify files, create commits, push branches, or attempt to update main.",
    "Inspect relevant source files and Git history when useful, then propose a merge order.",
    "The platform's dependency graph is authoritative. Never place a task before one of its included prerequisites.",
    "Include every task from the baseline exactly once, even when it is blocked or not yet submitted.",
    "Tasks already integrating must remain before tasks that are not integrating.",
    "Focus on semantic coupling, shared contracts, migrations, schemas, APIs, tests, and behavior that deterministic path analysis may miss.",
    `Admin instruction: ${input.instruction}`,
    `Dependencies: ${JSON.stringify(input.dependencies)}`,
    `Baseline plan and task evidence: ${JSON.stringify(payload)}`,
    "Return only one JSON object with this exact shape:",
    JSON.stringify({
      summary: "overall explanation",
      recommendedTaskIds: input.baselinePlan.items.map((item) => item.taskId),
      orderRationale: [{ taskId: "uuid", reason: "why this position is recommended" }],
      semanticConflicts: [{
        taskIds: ["uuid", "uuid"],
        severity: "warning or danger",
        summary: "conflict summary",
        evidence: ["specific file, symbol, schema, API, or behavior evidence"],
        recommendation: "how Admin should integrate or verify",
      }],
      uncertainties: ["facts that could not be confirmed"],
    }),
  ].join("\n\n");
}

const terminalStatuses = new Set<TaskStatus>(["merged", "rejected", "cancelled"]);

function readinessForTask(
  task: Task,
  blockingDependencies: MergePlanDependency[],
): MergePlanReadiness {
  if (task.status === "integrating") return "integrating";
  if (blockingDependencies.length > 0) return "blocked_by_dependency";
  if (task.status === "submitted") return "ready";
  if (task.status === "changes_requested") return "changes_requested";
  return "waiting_for_submission";
}

function readinessRank(readiness: MergePlanReadiness): number {
  if (readiness === "integrating") return 0;
  if (readiness === "ready") return 1;
  if (readiness === "changes_requested") return 2;
  if (readiness === "waiting_for_submission") return 3;
  return 4;
}

export function buildProjectMergePlan(input: {
  tasks: Task[];
  dependencies: TaskDependency[];
  scopeConflicts: TaskScopeConflict[];
  latestSnapshots: TaskWorkspaceSnapshot[];
  generatedAt?: string;
}): ProjectMergePlan {
  const candidates = input.tasks.filter((task) => !terminalStatuses.has(task.status));
  const candidateById = new Map(candidates.map((task) => [task.id, task]));
  const allTaskById = new Map(input.tasks.map((task) => [task.id, task]));
  const dependenciesByTask = new Map<string, TaskDependency[]>();
  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map(candidates.map((task) => [task.id, 0]));
  for (const dependency of input.dependencies) {
    const current = dependenciesByTask.get(dependency.taskId) ?? [];
    current.push(dependency);
    dependenciesByTask.set(dependency.taskId, current);
    if (candidateById.has(dependency.taskId) && candidateById.has(dependency.dependsOnTaskId)) {
      const dependents = outgoing.get(dependency.dependsOnTaskId) ?? new Set<string>();
      if (!dependents.has(dependency.taskId)) {
        dependents.add(dependency.taskId);
        outgoing.set(dependency.dependsOnTaskId, dependents);
        indegree.set(dependency.taskId, (indegree.get(dependency.taskId) ?? 0) + 1);
      }
    }
  }

  const conflictTaskIds = new Map<string, Set<string>>();
  for (const conflict of input.scopeConflicts) {
    const left = conflictTaskIds.get(conflict.leftTaskId) ?? new Set<string>();
    left.add(conflict.rightTaskId);
    conflictTaskIds.set(conflict.leftTaskId, left);
    const right = conflictTaskIds.get(conflict.rightTaskId) ?? new Set<string>();
    right.add(conflict.leftTaskId);
    conflictTaskIds.set(conflict.rightTaskId, right);
  }
  const snapshotByTask = new Map(input.latestSnapshots.map((snapshot) => [snapshot.taskId, snapshot]));

  const metrics = new Map(
    candidates.map((task) => {
      const blockingDependencies = (dependenciesByTask.get(task.id) ?? [])
        .filter((dependency) => dependency.dependsOnStatus !== "merged")
        .map((dependency) => ({
          taskId: dependency.dependsOnTaskId,
          title: dependency.dependsOnTitle,
          status: dependency.dependsOnStatus,
        }));
      const conflicts = [...(conflictTaskIds.get(task.id) ?? [])].sort();
      const requiresDependencyRepair = blockingDependencies.some((dependency) =>
        dependency.status === "rejected" || dependency.status === "cancelled",
      );
      const snapshot = snapshotByTask.get(task.id) ?? null;
      const actualOverlappingFiles = [...(snapshot?.overlappingFiles ?? [])].sort();
      const structuralConflicts = snapshot?.structuralConflicts ?? [];
      const hasDangerousStructuralConflict = structuralConflicts.some(
        (conflict) => conflict.severity === "danger",
      );
      const riskLevel: MergePlanRiskLevel =
        actualOverlappingFiles.length > 0 || hasDangerousStructuralConflict || conflicts.length >= 2
          ? "high"
          : structuralConflicts.length > 0 || conflicts.length === 1 || snapshot?.mainAdvanced
            ? "medium"
            : "low";
      return [
        task.id,
        {
          blockingDependencies,
          conflicts,
          snapshot,
          actualOverlappingFiles,
          structuralConflicts,
          riskLevel,
          readiness: readinessForTask(task, blockingDependencies),
          directDependentCount: outgoing.get(task.id)?.size ?? 0,
          requiresDependencyRepair,
        },
      ] as const;
    }),
  );

  const compareTasks = (left: Task, right: Task): number => {
    const leftMetrics = metrics.get(left.id)!;
    const rightMetrics = metrics.get(right.id)!;
    return (
      readinessRank(leftMetrics.readiness) - readinessRank(rightMetrics.readiness) ||
      Number(leftMetrics.requiresDependencyRepair) - Number(rightMetrics.requiresDependencyRepair) ||
      rightMetrics.directDependentCount - leftMetrics.directDependentCount ||
      leftMetrics.conflicts.length - rightMetrics.conflicts.length ||
      leftMetrics.structuralConflicts.length - rightMetrics.structuralConflicts.length ||
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.title.localeCompare(right.title)
    );
  };

  const available = candidates.filter((task) => (indegree.get(task.id) ?? 0) === 0).sort(compareTasks);
  const ordered: Task[] = [];
  while (available.length > 0) {
    const task = available.shift()!;
    ordered.push(task);
    for (const dependentId of outgoing.get(task.id) ?? []) {
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) {
        available.push(candidateById.get(dependentId)!);
        available.sort(compareTasks);
      }
    }
  }

  const remaining = candidates.filter((task) => !ordered.some((orderedTask) => orderedTask.id === task.id));
  const hasDependencyCycle = remaining.length > 0;
  ordered.push(...remaining.sort(compareTasks));

  const items = ordered.map((task, index): ProjectMergePlanItem => {
    const taskMetrics = metrics.get(task.id)!;
    const reasons: string[] = [];
    if (taskMetrics.readiness === "integrating") {
      reasons.push("This task is already in a temporary integration flow; complete or roll back that integration first");
    } else if (taskMetrics.readiness === "ready") {
      reasons.push("The change is submitted for review and all explicit dependencies are merged");
    } else if (taskMetrics.readiness === "blocked_by_dependency") {
      reasons.push(
        `Waiting for dependencies to merge: ${taskMetrics.blockingDependencies.map((dependency) => `${dependency.title} (${dependency.status})`).join(", ")}`,
      );
      if (taskMetrics.requiresDependencyRepair) {
        reasons.push("A dependency was rejected or cancelled; an Admin must update the dependency relationship first");
      }
    } else if (taskMetrics.readiness === "changes_requested") {
      reasons.push("Changes were requested; the task cannot enter integration until it is resubmitted");
    } else {
      reasons.push(`The task is currently ${task.status}; development must finish and the change must be submitted first`);
    }
    if (taskMetrics.directDependentCount > 0) {
      reasons.push(`${taskMetrics.directDependentCount} direct downstream tasks depend on it, so prioritize this foundational change`);
    }
    if (taskMetrics.conflicts.length > 0) {
      const conflictNames = taskMetrics.conflicts
        .map((taskId) => allTaskById.get(taskId)?.title ?? taskId)
        .join(", ");
      reasons.push(`Expected change scope overlaps ${taskMetrics.conflicts.length} tasks: ${conflictNames}`);
    }
    if (taskMetrics.actualOverlappingFiles.length > 0) {
      reasons.push(`Actual file overlap with latest main: ${taskMetrics.actualOverlappingFiles.join(", ")}`);
    }
    if (taskMetrics.structuralConflicts.length > 0) {
      reasons.push(
        `Detected ${taskMetrics.structuralConflicts.length} structural relationship risks: ${taskMetrics.structuralConflicts.slice(0, 2).map((conflict) => conflict.message).join("; ")}`,
      );
    }
    if (
      taskMetrics.actualOverlappingFiles.length === 0 &&
      taskMetrics.structuralConflicts.length === 0 &&
      taskMetrics.snapshot?.mainAdvanced
    ) {
      reasons.push("main advanced after task creation; revalidation is required before integration");
    }
    if (taskMetrics.snapshot && !taskMetrics.snapshot.workingTreeClean) {
      reasons.push("The Worktree still has uncommitted changes");
    }
    if (hasDependencyCycle) {
      reasons.push("A dependency cycle was detected; an Admin must fix it before using the recommended integration order");
    }
    return {
      position: index + 1,
      taskId: task.id,
      title: task.title,
      status: task.status,
      readiness: taskMetrics.readiness,
      riskLevel: taskMetrics.riskLevel,
      assignedUserName: task.assignedUserName ?? null,
      blockingDependencies: taskMetrics.blockingDependencies,
      conflictTaskIds: taskMetrics.conflicts,
      actualOverlappingFiles: taskMetrics.actualOverlappingFiles,
      structuralConflicts: taskMetrics.structuralConflicts,
      mainAdvanced: taskMetrics.snapshot?.mainAdvanced ?? false,
      workingTreeClean: taskMetrics.snapshot?.workingTreeClean ?? null,
      directDependentCount: taskMetrics.directDependentCount,
      requiresDependencyRepair: taskMetrics.requiresDependencyRepair,
      reasons,
    };
  });

  return {
    method: "dependency-aware-risk-heuristic-v2",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    hasDependencyCycle,
    readyTaskIds: items.filter((item) => item.readiness === "ready").map((item) => item.taskId),
    items,
  };
}
