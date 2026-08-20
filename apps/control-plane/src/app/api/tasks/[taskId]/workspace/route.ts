import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { getRunner, getTask } from "@/lib/repositories";
import { durableProvisionTaskWorkspace } from "@/temporal/client";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const { taskId } = await context.params;
    const actor = await requireCurrentUser();
    const result = await durableProvisionTaskWorkspace({ taskId, actorId: actor.id });
    return Response.json({
      task: await getTask(result.taskId),
      runner: await getRunner(result.runnerId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
