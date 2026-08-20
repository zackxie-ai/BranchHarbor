import { requireCurrentUser } from "@/lib/auth";
import { requireProjectMembership } from "@/lib/authorization";
import { errorResponse } from "@/lib/errors";
import { listProjectMembers } from "@/lib/repositories";
import { addProjectMember } from "@/lib/services";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const actor = await requireCurrentUser();
    await requireProjectMembership(actor.id, projectId);
    return Response.json({ members: await listProjectMembers(projectId) });
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
    const result = await addProjectMember(projectId, await request.json(), actor.id);
    return Response.json({ membership: result }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
