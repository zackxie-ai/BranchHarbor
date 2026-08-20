import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import {
  getTaskWorkspaceBackup,
  getTaskWorkspaceProgress,
  getTaskWorkspaceProgressHistory,
} from "@/lib/services";

export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const { taskId } = await context.params;
    const actor = await requireCurrentUser();
    const progress = await getTaskWorkspaceProgress(taskId, actor.id);
    const [snapshots, backup] = await Promise.all([
      getTaskWorkspaceProgressHistory(taskId, actor.id),
      getTaskWorkspaceBackup(taskId, actor.id),
    ]);
    return Response.json({ progress, snapshots, backup });
  } catch (error) {
    return errorResponse(error);
  }
}
