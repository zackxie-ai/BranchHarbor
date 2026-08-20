import { AppError } from "./errors";

export const taskStatuses = [
  "draft",
  "workspace_ready",
  "active",
  "submitted",
  "changes_requested",
  "rejected",
  "integrating",
  "merged",
  "cancelled",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];

export const changeRequestStatuses = [
  "submitted",
  "changes_requested",
  "rejected",
  "cancelled",
  "approved_for_integration",
  "integrating",
  "awaiting_final_approval",
  "merged",
  "integration_failed",
] as const;

export type ChangeRequestStatus = (typeof changeRequestStatuses)[number];

export type ReviewDecision =
  | "request_changes"
  | "reject"
  | "approve_integration"
  | "approve_final";

const taskTransitions: Record<TaskStatus, TaskStatus[]> = {
  draft: ["workspace_ready", "cancelled"],
  workspace_ready: ["active", "submitted", "cancelled"],
  active: ["submitted", "cancelled"],
  submitted: ["changes_requested", "rejected", "integrating"],
  changes_requested: ["active", "submitted", "cancelled"],
  rejected: [],
  integrating: ["merged", "changes_requested"],
  merged: [],
  cancelled: [],
};

const changeRequestTransitions: Record<ChangeRequestStatus, ChangeRequestStatus[]> = {
  submitted: ["changes_requested", "rejected", "approved_for_integration"],
  changes_requested: ["submitted", "rejected", "cancelled"],
  rejected: [],
  cancelled: [],
  approved_for_integration: ["integrating"],
  integrating: ["awaiting_final_approval", "integration_failed"],
  awaiting_final_approval: ["merged", "integration_failed"],
  merged: [],
  integration_failed: ["approved_for_integration", "rejected"],
};

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!taskTransitions[from].includes(to)) {
    throw new AppError(
      `Task cannot move from ${from} to ${to}`,
      409,
      "INVALID_TASK_TRANSITION",
    );
  }
}

export function assertChangeRequestTransition(
  from: ChangeRequestStatus,
  to: ChangeRequestStatus,
): void {
  if (!changeRequestTransitions[from].includes(to)) {
    throw new AppError(
      `Change request cannot move from ${from} to ${to}`,
      409,
      "INVALID_CHANGE_REQUEST_TRANSITION",
    );
  }
}

export function statusLabel(status: string): string {
  return status
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
