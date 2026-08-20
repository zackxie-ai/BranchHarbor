import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { authorizeIntegrationAgentStart } from "@/lib/services";
import { durableRunIntegrationAgent } from "@/temporal/client";

export async function POST(
  request: Request,
  context: { params: Promise<{ integrationId: string }> },
) {
  try {
    const { integrationId } = await context.params;
    const actor = await requireCurrentUser();
    const authorized = await authorizeIntegrationAgentStart(
      integrationId,
      await request.json(),
      actor.id,
    );
    const workflow = await durableRunIntegrationAgent({
      integrationId,
      agentConnectionId: authorized.agentConnectionId,
      prompt: authorized.prompt,
      resumeSessionId: authorized.resumeSessionId,
      actorId: actor.id,
    });
    return Response.json({ workflow }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
