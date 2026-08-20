import { requireCurrentUser } from "@/lib/auth";
import {
  assertOrganizationAdmin,
  requireIntegrationMembership,
  requireTaskMembership,
} from "@/lib/authorization";
import { errorResponse } from "@/lib/errors";
import { getAgentSession, listAgentEventsAfter } from "@/lib/repositories";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sse(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await context.params;
    const actor = await requireCurrentUser();
    const initialSession = await getAgentSession(sessionId);
    if (initialSession.taskId) {
      await requireTaskMembership(actor.id, initialSession.taskId);
    } else if (initialSession.integrationId) {
      const integrationContext = await requireIntegrationMembership(
        actor.id,
        initialSession.integrationId,
      );
      assertOrganizationAdmin(integrationContext.role);
    } else {
      throw new Error("Agent session has no authorization scope");
    }
    const url = new URL(request.url);
    const parsedAfter = Number(url.searchParams.get("after") ?? 0);
    const initialAfter = Number.isSafeInteger(parsedAfter) && parsedAfter >= 0 ? parsedAfter : 0;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let cursor = initialAfter;
        const deadline = Date.now() + 25_000;
        controller.enqueue(encoder.encode(sse("connected", { sessionId, cursor })));

        while (!request.signal.aborted && Date.now() < deadline) {
          const events = await listAgentEventsAfter(sessionId, cursor);
          for (const event of events) {
            cursor = event.sequenceNumber;
            controller.enqueue(encoder.encode(sse("agent-event", event, cursor)));
          }

          const session = await getAgentSession(sessionId);
          if (["completed", "failed", "stopped"].includes(session.status)) {
            controller.enqueue(
              encoder.encode(sse("session-status", { status: session.status, cursor })),
            );
            controller.close();
            return;
          }

          controller.enqueue(encoder.encode(": keep-alive\n\n"));
          await new Promise((resolve) => setTimeout(resolve, 750));
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
