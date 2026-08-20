import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { durableCancelTask } from "@/temporal/client";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const { taskId } = await context.params;
    const actor = await requireCurrentUser();
    const result = await durableCancelTask({ taskId, actorId: actor.id });
    return Response.json({ task: result });
  } catch (error) {
    return errorResponse(error);
  }
}
