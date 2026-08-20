import { afterEach, describe, expect, it, vi } from "vitest";

import { runnerPreviewUrl, waitForRunnerPreview } from "../runner";
import type { TaskRunner } from "../types";
import { startTaskPreviewSchema } from "../validation";

const runner: TaskRunner = {
  id: "00000000-0000-4000-8000-000000000301",
  taskId: "00000000-0000-4000-8000-000000000401",
  integrationId: null,
  projectMergePlanRunId: null,
  projectValidationRunId: null,
  provider: "aio-sandbox",
  containerName: "cloudagent-task-preview",
  image: "sandbox",
  status: "running",
  baseUrl: "http://127.0.0.1:49152",
  hostPort: 49152,
  workspacePath: "/tmp/workspace",
  containerWorkspacePath: "/home/gem/workspace",
  credentialRef: "openbao://secret/runner",
  resourceLimits: { memory: "4g", cpus: "2" },
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("task preview policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a per-run localhost capability URL on the Runner port", () => {
    const url = new URL(
      runnerPreviewUrl(runner, 3000, "12345678-1234-4000-8000-123456789abc"),
    );
    expect(url.hostname).toBe("3000-12345678-123.preview.localhost");
    expect(url.port).toBe("49152");
  });

  it("accepts bounded application ports and rejects privileged ports", () => {
    expect(
      startTaskPreviewSchema.parse({ command: "pnpm dev", port: "3000" }),
    ).toEqual({ command: "pnpm dev", port: 3000 });
    expect(() =>
      startTaskPreviewSchema.parse({ command: "pnpm dev", port: 80 }),
    ).toThrow();
  });

  it("cancels the readiness probe body after receiving usable headers", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, body: { cancel } });
    vi.stubGlobal("fetch", fetchMock);

    await waitForRunnerPreview("http://preview.localhost/");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
