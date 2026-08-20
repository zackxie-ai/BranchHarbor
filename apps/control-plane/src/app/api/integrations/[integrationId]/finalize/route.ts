import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { durableFinalizeIntegration } from "@/temporal/client";

export async function POST(
  request: Request,
  context: { params: Promise<{ integrationId: string }> },
) {
  try {
    const { integrationId } = await context.params;
    const actor = await requireCurrentUser();
    const body = (await request.json().catch(() => ({}))) as { comment?: string };
    const result = await durableFinalizeIntegration({
      integrationId,
      actorId: actor.id,
      comment: body.comment,
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
