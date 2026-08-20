import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import {
  failProjectValidationRunLaunch,
  getProjectIntegrationQueueHistory,
  getProjectValidationHistory,
  queueProjectValidationRun,
} from "@/lib/services";
import { durableRunProjectValidation } from "@/temporal/client";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const actor = await requireCurrentUser();
    const [queues, runs] = await Promise.all([
      getProjectIntegrationQueueHistory(projectId, actor.id),
      getProjectValidationHistory(projectId, actor.id),
    ]);
    return Response.json({ queues, runs });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const actor = await requireCurrentUser();
    const run = await queueProjectValidationRun(projectId, await request.json(), actor.id);
    try {
      const workflow = await durableRunProjectValidation({ runId: run.id, actorId: actor.id });
      return Response.json({ run, workflow }, { status: 202 });
    } catch (error) {
      await failProjectValidationRunLaunch(run.id, error, actor.id);
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
