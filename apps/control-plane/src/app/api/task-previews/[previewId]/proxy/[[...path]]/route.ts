import { requireCurrentUser } from "@/lib/auth";
import { requireTaskMembership } from "@/lib/authorization";
import { errorResponse } from "@/lib/errors";
import { getTaskPreviewRun, getTaskRunner } from "@/lib/repositories";
import { runnerPreviewUrl } from "@/lib/runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const hopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

async function handlePreviewProxy(
  request: Request,
  context: { params: Promise<{ previewId: string; path?: string[] }> },
) {
  const { previewId, path: pathSegments = [] } = await context.params;
  const actor = await requireCurrentUser();
  const preview = await getTaskPreviewRun(previewId);
  await requireTaskMembership(actor.id, preview.taskId);
  if (preview.status !== "running") {
    return Response.json(
      { error: "Preview is not running", code: "TASK_PREVIEW_NOT_RUNNING" },
      { status: 409 },
    );
  }
  const runner = await getTaskRunner(preview.taskId);
  if (!runner || runner.id !== preview.runnerId) {
    return Response.json(
      { error: "Preview Runner is unavailable", code: "RUNNER_NOT_FOUND" },
      { status: 409 },
    );
  }

  const directUrl = new URL(runnerPreviewUrl(runner, preview.port, preview.id));
  const encodedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join("/");
  directUrl.pathname = `/${encodedPath}`;
  directUrl.search = new URL(request.url).search;
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("x-aio-api-key");
  headers.set("host", directUrl.hostname);
  headers.set("x-forwarded-host", new URL(request.url).host);

  const method = request.method.toUpperCase();
  const body = ["GET", "HEAD"].includes(method)
    ? undefined
    : await request.arrayBuffer();
  const upstream = await fetch(directUrl, {
    method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!hopByHopHeaders.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });
  const location = responseHeaders.get("location");
  if (location) {
    const upstreamLocation = new URL(location, directUrl);
    if (upstreamLocation.origin === directUrl.origin) {
      const proxyBase = `/api/task-previews/${preview.id}/proxy`;
      responseHeaders.set(
        "location",
        `${proxyBase}${upstreamLocation.pathname}${upstreamLocation.search}${upstreamLocation.hash}`,
      );
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

async function route(
  request: Request,
  context: { params: Promise<{ previewId: string; path?: string[] }> },
) {
  try {
    return await handlePreviewProxy(request, context);
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = route;
export const HEAD = route;
export const POST = route;
export const PUT = route;
export const PATCH = route;
export const DELETE = route;
export const OPTIONS = route;
