import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import {
  getTaskDependencyHistory,
  recoverTaskDependency,
  updateTaskDependencies,
} from "@/lib/services";

export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const { taskId } = await context.params;
    const actor = await requireCurrentUser();
    const revisions = await getTaskDependencyHistory(taskId, actor.id);
    return Response.json({ revisions });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const { taskId } = await context.params;
    const actor = await requireCurrentUser();
    const dependencies = await updateTaskDependencies(taskId, await request.json(), actor.id);
    return Response.json({ dependencies });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const { taskId } = await context.params;
    const actor = await requireCurrentUser();
    return Response.json(
      await recoverTaskDependency(taskId, await request.json(), actor.id),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
