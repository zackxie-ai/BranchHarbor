import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { reviewChangeRequest } from "@/lib/services";

export async function POST(
  request: Request,
  context: { params: Promise<{ changeRequestId: string }> },
) {
  try {
    const { changeRequestId } = await context.params;
    const actor = await requireCurrentUser();
    const changeRequest = await reviewChangeRequest(
      changeRequestId,
      await request.json(),
      actor.id,
    );
    return Response.json({ changeRequest });
  } catch (error) {
    return errorResponse(error);
  }
}
