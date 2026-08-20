import type { ChangeRequestStatus, TaskStatus } from "./domain";
import { AppError } from "./errors";
import type {
  ProjectMergePlan,
  ProjectMergePlanAgentRun,
} from "./merge-planning";

export type IntegrationQueueSource = "deterministic" | "semantic";

export interface ProjectIntegrationQueueItem {
  position: number;
  taskId: string;
  taskTitle: string;
  taskStatus: TaskStatus;
  changeRequestId: string;
  changeRequestStatus: ChangeRequestStatus;
  headCommit: string;
}

export interface ProjectIntegrationQueue {
  id: string;
  projectId: string;
  status: "active" | "completed" | "cancelled";
  source: IntegrationQueueSource;
  sourceMergePlanRunId: string | null;
  createdBy: string;
  cancelledBy: string | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  cancelledAt: Date | null;
  completedAt: Date | null;
  items: ProjectIntegrationQueueItem[];
}

export interface IntegrationQueueGate {
  queueId: string | null;
  queued: boolean;
  position: number | null;
  allowed: boolean;
  reason: string | null;
  blockingItems: ProjectIntegrationQueueItem[];
}

export function isIntegrationQueueItemTerminal(
  item: ProjectIntegrationQueueItem,
): boolean {
  return ["merged", "rejected", "cancelled"].includes(item.changeRequestStatus);
}

export function buildIntegrationQueueGate(
  queue: ProjectIntegrationQueue | null,
  changeRequestId: string,
): IntegrationQueueGate {
  if (!queue) {
    return {
      queueId: null,
      queued: false,
      position: null,
      allowed: true,
      reason: null,
      blockingItems: [],
    };
  }
  const item = queue.items.find((candidate) => candidate.changeRequestId === changeRequestId);
  if (!item) {
    return {
      queueId: queue.id,
      queued: false,
      position: null,
      allowed: false,
      reason: "This Change Request is not included in the active Integration Queue",
      blockingItems: [],
    };
  }
  const blockingItems = queue.items.filter(
    (candidate) => candidate.position < item.position && !isIntegrationQueueItemTerminal(candidate),
  );
  return {
    queueId: queue.id,
    queued: true,
    position: item.position,
    allowed: blockingItems.length === 0,
    reason: blockingItems.length > 0
      ? `Complete or close the earlier queued tasks first: ${blockingItems.map((candidate) => candidate.taskTitle).join(", ")}`
      : null,
    blockingItems,
  };
}

export function buildIntegrationQueueTaskOrder(input: {
  source: IntegrationQueueSource;
  selectedTaskIds: string[];
  mergePlan: ProjectMergePlan;
  semanticRun: ProjectMergePlanAgentRun | null;
}): string[] {
  const selectedTaskIds = [...new Set(input.selectedTaskIds)];
  if (selectedTaskIds.length !== input.selectedTaskIds.length) {
    throw new AppError(
      "An integration queue cannot contain duplicate tasks",
      400,
      "INTEGRATION_QUEUE_DUPLICATE_TASK",
    );
  }
  const readyTaskIdSet = new Set(input.mergePlan.readyTaskIds);
  const invalidTaskIds = selectedTaskIds.filter((taskId) => !readyTaskIdSet.has(taskId));
  if (invalidTaskIds.length > 0) {
    throw new AppError(
      "Every queued task must currently be ready for integration",
      409,
      "INTEGRATION_QUEUE_TASK_NOT_READY",
    );
  }

  const sourceOrder = input.source === "deterministic"
    ? input.mergePlan.items.map((item) => item.taskId)
    : (() => {
        if (input.semanticRun?.status !== "completed" || !input.semanticRun.suggestion) {
          throw new AppError(
            "Run and validate a semantic merge plan before adopting it",
            409,
            "INTEGRATION_QUEUE_SEMANTIC_PLAN_MISSING",
          );
        }
        return input.semanticRun.suggestion.recommendedTaskIds;
      })();
  const sourceTaskIdSet = new Set(sourceOrder);
  if (selectedTaskIds.some((taskId) => !sourceTaskIdSet.has(taskId))) {
    throw new AppError(
      "The selected merge plan is stale and does not contain every chosen task",
      409,
      "INTEGRATION_QUEUE_PLAN_STALE",
    );
  }
  const selectedTaskIdSet = new Set(selectedTaskIds);
  return sourceOrder.filter((taskId) => selectedTaskIdSet.has(taskId));
}
