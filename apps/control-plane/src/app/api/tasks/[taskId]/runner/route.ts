import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { getRunner } from "@/lib/repositories";
import { durableStartTaskRunner } from "@/temporal/client";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const { taskId } = await context.params;
    const actor = await requireCurrentUser();
    const result = await durableStartTaskRunner({ taskId, actorId: actor.id });
    return Response.json({ runner: await getRunner(result.runnerId) });
  } catch (error) {
    return errorResponse(error);
  }
}
