import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { listProjects } from "@/lib/repositories";
import { createProject } from "@/lib/services";

export async function GET() {
  try {
    const actor = await requireCurrentUser();
    return Response.json({ projects: await listProjects(actor.id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireCurrentUser();
    const project = await createProject(await request.json(), actor.id);
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
