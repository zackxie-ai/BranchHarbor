import { requireCurrentUser } from "@/lib/auth";
import { requireProjectMembership } from "@/lib/authorization";
import { errorResponse } from "@/lib/errors";
import {
  listTaskDependencies,
  listTaskScopeConflicts,
  listTasks,
} from "@/lib/repositories";
import { createTask } from "@/lib/services";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const actor = await requireCurrentUser();
    await requireProjectMembership(actor.id, projectId);
    const [tasks, dependencies, scopeConflicts] = await Promise.all([
      listTasks(projectId),
      listTaskDependencies(projectId),
      listTaskScopeConflicts(projectId),
    ]);
    return Response.json({ tasks, dependencies, scopeConflicts });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const actor = await requireCurrentUser();
    const task = await createTask(projectId, await request.json(), actor.id);
    return Response.json({ task }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
