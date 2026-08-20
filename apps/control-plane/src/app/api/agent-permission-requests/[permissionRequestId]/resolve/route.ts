import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { resolveAgentPermission } from "@/lib/services";

export async function POST(
  request: Request,
  context: { params: Promise<{ permissionRequestId: string }> },
) {
  try {
    const { permissionRequestId } = await context.params;
    const actor = await requireCurrentUser();
    const permission = await resolveAgentPermission(
      permissionRequestId,
      await request.json(),
      actor.id,
    );
    return Response.json({ permission });
  } catch (error) {
    return errorResponse(error);
  }
}
