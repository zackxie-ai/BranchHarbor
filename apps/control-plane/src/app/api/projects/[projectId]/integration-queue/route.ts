import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import {
  cancelProjectIntegrationQueue,
  getProjectIntegrationQueue,
  replaceProjectIntegrationQueue,
} from "@/lib/services";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const actor = await requireCurrentUser();
    const queue = await getProjectIntegrationQueue(projectId, actor.id);
    return Response.json({ queue });
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
    const queue = await replaceProjectIntegrationQueue(projectId, await request.json(), actor.id);
    return Response.json({ queue }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const actor = await requireCurrentUser();
    const queue = await cancelProjectIntegrationQueue(projectId, await request.json(), actor.id);
    return Response.json({ queue });
  } catch (error) {
    return errorResponse(error);
  }
}
