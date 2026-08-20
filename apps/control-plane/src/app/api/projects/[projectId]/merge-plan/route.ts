import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import {
  getLatestProjectMergePlanAgentRun,
  getProjectMergePlan,
  queueProjectMergePlanAgentRun,
} from "@/lib/services";
import { durableRunProjectMergePlanAgent } from "@/temporal/client";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const actor = await requireCurrentUser();
    const [mergePlan, latestAgentRun] = await Promise.all([
      getProjectMergePlan(projectId, actor.id),
      getLatestProjectMergePlanAgentRun(projectId, actor.id),
    ]);
    return Response.json({ mergePlan, latestAgentRun });
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
    const run = await queueProjectMergePlanAgentRun(projectId, await request.json(), actor.id);
    const workflow = await durableRunProjectMergePlanAgent({ runId: run.id, actorId: actor.id });
    return Response.json({ run, workflow }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
