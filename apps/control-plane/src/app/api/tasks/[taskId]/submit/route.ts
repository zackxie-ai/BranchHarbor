import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { getChangeRequest } from "@/lib/repositories";
import { durableSubmitTaskChange } from "@/temporal/client";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const { taskId } = await context.params;
    const actor = await requireCurrentUser();
    const body = (await request.json()) as { summary: string; risks?: string[] };
    const result = await durableSubmitTaskChange({
      taskId,
      actorId: actor.id,
      summary: body.summary,
      risks: body.risks ?? [],
    });
    const changeRequest = await getChangeRequest(result.changeRequestId);
    return Response.json({ changeRequest }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
