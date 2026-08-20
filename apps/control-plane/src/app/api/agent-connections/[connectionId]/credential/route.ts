import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { configureAgentCredential, revokeAgentCredential } from "@/lib/services";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
) {
  try {
    const { connectionId } = await context.params;
    const actor = await requireCurrentUser();
    const connection = await configureAgentCredential(
      connectionId,
      await request.json(),
      actor.id,
    );
    return Response.json({ connection });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ connectionId: string }> },
) {
  try {
    const { connectionId } = await context.params;
    const actor = await requireCurrentUser();
    const connection = await revokeAgentCredential(connectionId, actor.id);
    return Response.json({ connection });
  } catch (error) {
    return errorResponse(error);
  }
}
