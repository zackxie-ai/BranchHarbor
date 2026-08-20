import type { TaskStatus } from "./domain";
import type { TaskScopeConflict } from "./types";

const terminalTaskStatuses = new Set<TaskStatus>(["merged", "rejected", "cancelled"]);

export function normalizeTaskScope(value: string): string {
  let normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/(?:\*\*|\*)$/, "")
    .replace(/\/+$/, "");

  if (
    !normalized ||
    normalized === "*" ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Task change scopes must be repository-relative paths");
  }

  return normalized;
}

export function isValidTaskScope(value: string): boolean {
  try {
    normalizeTaskScope(value);
    return true;
  } catch {
    return false;
  }
}

export function taskScopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function normalizeTaskScopes(values: string[]): string[] {
  const unique = [...new Set(values.map(normalizeTaskScope))].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  return unique.filter(
    (scope, index) => !unique.slice(0, index).some((parent) => taskScopesOverlap(parent, scope)),
  );
}

export function pathMatchesTaskScope(filePath: string, scope: string): boolean {
  const normalizedPath = normalizeTaskScope(filePath);
  const normalizedScope = normalizeTaskScope(scope);
  return normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
}

export function findFilesOutsideTaskScopes(filePaths: string[], scopes: string[]): string[] {
  if (scopes.length === 0) return [];
  const normalizedScopes = normalizeTaskScopes(scopes);
  return filePaths.filter(
    (filePath) => !normalizedScopes.some((scope) => pathMatchesTaskScope(filePath, scope)),
  );
}

export function findTaskScopeConflicts(
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    expectedChangeScopes: string[];
  }>,
): TaskScopeConflict[] {
  const activeTasks = tasks.filter(
    (task) => !terminalTaskStatuses.has(task.status) && task.expectedChangeScopes.length > 0,
  );
  const conflicts: TaskScopeConflict[] = [];

  for (let leftIndex = 0; leftIndex < activeTasks.length; leftIndex += 1) {
    const left = activeTasks[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < activeTasks.length; rightIndex += 1) {
      const right = activeTasks[rightIndex]!;
      const overlaps = left.expectedChangeScopes.flatMap((leftScope) =>
        right.expectedChangeScopes
          .filter((rightScope) => taskScopesOverlap(leftScope, rightScope))
          .map((rightScope) => ({ leftScope, rightScope })),
      );
      if (overlaps.length > 0) {
        conflicts.push({
          leftTaskId: left.id,
          leftTaskTitle: left.title,
          rightTaskId: right.id,
          rightTaskTitle: right.title,
          overlaps,
        });
      }
    }
  }

  return conflicts;
}
