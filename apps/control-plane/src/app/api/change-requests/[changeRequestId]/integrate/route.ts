import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { getIntegrationRun } from "@/lib/repositories";
import { durableStartIntegration } from "@/temporal/client";

export async function POST(
  request: Request,
  context: { params: Promise<{ changeRequestId: string }> },
) {
  try {
    const { changeRequestId } = await context.params;
    const actor = await requireCurrentUser();
    const result = await durableStartIntegration({ changeRequestId, actorId: actor.id });
    const integration = await getIntegrationRun(result.integrationId);
    return Response.json({ integration }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
