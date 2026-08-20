import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { refreshTaskPreview } from "@/lib/services";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ previewId: string }> },
) {
  try {
    const { previewId } = await context.params;
    const actor = await requireCurrentUser();
    const preview = await refreshTaskPreview(previewId, actor.id);
    return Response.json(
      {
        preview: {
          id: preview.id,
          taskId: preview.taskId,
          command: preview.command,
          port: preview.port,
          status: preview.status,
          previewUrl: preview.previewUrl,
          output: preview.output,
          exitCode: preview.exitCode,
          errorMessage: preview.errorMessage,
          startedAt: preview.startedAt,
          endedAt: preview.endedAt,
          updatedAt: preview.updatedAt,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
