import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeInRunner } from "../runner";
import type { TaskRunner } from "../types";

vi.mock("../openbao", () => ({
  readSecret: vi.fn().mockResolvedValue({ api_key: "runner-key" }),
  writeSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));

const runner: TaskRunner = {
  id: "00000000-0000-4000-8000-000000000501",
  taskId: "00000000-0000-4000-8000-000000000502",
  integrationId: null,
  projectMergePlanRunId: null,
  projectValidationRunId: null,
  provider: "aio-sandbox",
  containerName: "cloudagent-runner-command-test",
  image: "sandbox",
  status: "running",
  baseUrl: "http://127.0.0.1:49153",
  hostPort: 49153,
  workspacePath: "/tmp/workspace",
  containerWorkspacePath: "/home/gem/workspace",
  credentialRef: "openbao://secret/runner",
  resourceLimits: { memory: "4g", cpus: "2" },
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("runner command execution", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("polls the Bash API and preserves a non-zero exit code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          session_id: "session-1",
          command_id: "command-1",
          status: "running",
          stdout: "",
          stderr: "",
          offset: 0,
          stderr_offset: 0,
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          stdout: "joint failure\n",
          stderr: "details\n",
          offset: 14,
          stderr_offset: 8,
          command: { status: "completed", exit_code: 7 },
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeInRunner(runner, "exit 7");

    expect(result.exitCode).toBe(7);
    expect(result.output).toContain("joint failure");
    expect(result.output).toContain("details");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${runner.baseUrl}/v1/bash/exec`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${runner.baseUrl}/v1/bash/output`);
  });
});
