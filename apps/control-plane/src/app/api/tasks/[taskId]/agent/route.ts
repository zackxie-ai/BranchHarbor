import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { authorizeTaskAgentStart } from "@/lib/services";
import { durableRunTaskAgent } from "@/temporal/client";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const { taskId } = await context.params;
    const actor = await requireCurrentUser();
    const authorized = await authorizeTaskAgentStart(taskId, await request.json(), actor.id);
    const workflow = await durableRunTaskAgent({
      taskId,
      prompt: authorized.prompt,
      resumeSessionId: authorized.resumeSessionId,
      actorId: actor.id,
    });
    return Response.json({ workflow }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
