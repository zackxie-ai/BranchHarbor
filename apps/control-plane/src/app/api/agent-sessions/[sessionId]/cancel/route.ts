import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { cancelAgentSession } from "@/lib/services";

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await context.params;
    const actor = await requireCurrentUser();
    const session = await cancelAgentSession(sessionId, actor.id);
    return Response.json({ session }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
