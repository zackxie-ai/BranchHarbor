import { AppError } from "./errors";
import {
  getChangeRequest,
  getIntegrationRun,
  getProjectAccessRole,
  getOrganizationRole,
  getProject,
  getRunner,
  getTask,
} from "./repositories";
import type { Project, Task } from "./types";

export type OrganizationRole = "admin" | "member";

export function assertOrganizationMember(
  role: OrganizationRole | null,
): asserts role is OrganizationRole {
  if (!role) {
    throw new AppError("You do not have access to this project", 403, "FORBIDDEN");
  }
}

export function assertOrganizationAdmin(
  role: OrganizationRole | null,
): asserts role is "admin" {
  if (role !== "admin") {
    throw new AppError("Admin permission is required", 403, "ADMIN_REQUIRED");
  }
}

export function assertCredentialOwner(actorId: string, ownerId: string): void {
  if (actorId !== ownerId) {
    throw new AppError("You cannot configure another user's Agent", 403, "FORBIDDEN");
  }
}

export function assertTaskOperator(input: {
  actorId: string;
  assignedUserId: string;
  role: OrganizationRole | null;
}): void {
  assertOrganizationMember(input.role);
  if (input.role !== "admin" && input.actorId !== input.assignedUserId) {
    throw new AppError(
      "Only the assigned member or an Admin can operate this task",
      403,
      "FORBIDDEN",
    );
  }
}

export async function requireProjectMembership(
  actorId: string,
  projectId: string,
): Promise<{ project: Project; role: OrganizationRole }> {
  const project = await getProject(projectId);
  const role = await getProjectAccessRole(actorId, project.id);
  assertOrganizationMember(role);
  return { project, role };
}

export async function requireTaskMembership(
  actorId: string,
  taskId: string,
): Promise<{ task: Task; project: Project; role: OrganizationRole }> {
  const task = await getTask(taskId);
  const { project, role } = await requireProjectMembership(actorId, task.projectId);
  return { task, project, role };
}

export async function requireChangeRequestMembership(
  actorId: string,
  changeRequestId: string,
) {
  const changeRequest = await getChangeRequest(changeRequestId);
  const context = await requireTaskMembership(actorId, changeRequest.taskId);
  return { changeRequest, ...context };
}

export async function requireIntegrationMembership(actorId: string, integrationId: string) {
  const integration = await getIntegrationRun(integrationId);
  const context = await requireChangeRequestMembership(actorId, integration.changeRequestId);
  return { integration, ...context };
}

export async function requireRunnerMembership(actorId: string, runnerId: string) {
  const runner = await getRunner(runnerId);
  if (runner.taskId) {
    const context = await requireTaskMembership(actorId, runner.taskId);
    assertTaskOperator({
      actorId,
      assignedUserId: context.task.assignedUserId,
      role: context.role,
    });
    return { runner, ...context };
  }
  if (runner.integrationId) {
    const context = await requireIntegrationMembership(actorId, runner.integrationId);
    assertOrganizationAdmin(context.role);
    return { runner, ...context };
  }
  throw new AppError("Runner is not attached to a project", 409, "RUNNER_ORPHANED");
}
