import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { getProjectNotifications, markProjectNotificationsRead } from "@/lib/services";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const actor = await requireCurrentUser();
    const notifications = await getProjectNotifications(projectId, actor.id);
    return Response.json({ notifications });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const actor = await requireCurrentUser();
    const notifications = await markProjectNotificationsRead(
      projectId,
      await request.json(),
      actor.id,
    );
    return Response.json({ notifications });
  } catch (error) {
    return errorResponse(error);
  }
}
