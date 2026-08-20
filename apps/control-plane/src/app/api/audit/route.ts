import { requireCurrentUser } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import {
  getOrganizationAuditEventTypes,
  getOrganizationAuditLog,
} from "@/lib/services";

export async function GET(request: Request) {
  try {
    const actor = await requireCurrentUser();
    const filters = Object.fromEntries(new URL(request.url).searchParams.entries());
    const [page, eventTypes] = await Promise.all([
      getOrganizationAuditLog(filters, actor.id),
      getOrganizationAuditEventTypes(actor.id),
    ]);
    return Response.json({ page, eventTypes });
  } catch (error) {
    return errorResponse(error);
  }
}
