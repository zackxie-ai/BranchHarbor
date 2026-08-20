import { requireCurrentUser } from "@/lib/auth";
import { requireRunnerMembership } from "@/lib/authorization";
import { errorResponse } from "@/lib/errors";
import { runnerAccessUrl } from "@/lib/runner";

export async function GET(
  request: Request,
  context: { params: Promise<{ runnerId: string }> },
) {
  try {
    const { runnerId } = await context.params;
    const actor = await requireCurrentUser();
    const surfaceValue = new URL(request.url).searchParams.get("surface");
    const surface =
      surfaceValue === "code-server" || surfaceValue === "vnc" ? surfaceValue : "home";
    const { runner } = await requireRunnerMembership(actor.id, runnerId);
    return Response.redirect(await runnerAccessUrl(runner, surface));
  } catch (error) {
    return errorResponse(error);
  }
}
