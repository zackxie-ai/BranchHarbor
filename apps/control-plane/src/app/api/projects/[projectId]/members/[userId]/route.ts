import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { removeProjectMember } from "@/lib/services";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ projectId: string; userId: string }> },
) {
  try {
    const { projectId, userId } = await context.params;
    const actor = await requireCurrentUser();
    const result = await removeProjectMember(projectId, userId, actor.id);
    return Response.json({ membership: result });
  } catch (error) {
    return errorResponse(error);
  }
}
