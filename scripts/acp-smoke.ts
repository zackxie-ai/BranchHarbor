import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

import { runAcpSession } from "../apps/control-plane/src/lib/agent-gateway";
import type { AgentConnection, TaskRunner } from "../apps/control-plane/src/lib/types";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const containerName = `cloudagent-acp-smoke-${randomUUID().slice(0, 8)}`;
const image = process.env.SANDBOX_IMAGE ?? "ghcr.io/agent-infra/sandbox:1.11.0";
const apiKey = randomBytes(32).toString("base64url");

const connection: AgentConnection & { credentialRef: string | null } = {
  id: "00000000-0000-4000-8000-000000000903",
  userId: "00000000-0000-4000-8000-000000000904",
  provider: "mock",
  displayName: "Mock ACP Agent",
  protocol: "acp",
  status: "ready",
  model: null,
  credentialConfigured: true,
  launcherCommand: "node",
  launcherArguments: ["/tmp/mock-acp-agent.mjs"],
  credentialEnvironmentVariable: "MOCK_API_KEY",
  credentialRef: "openbao://smoke",
};

async function docker(args: string[]): Promise<string> {
  const result = await execFileAsync("docker", args, {
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function waitUntilReady(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastError = "Runner did not respond";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/docs`, {
        headers: { "X-AIO-API-Key": apiKey },
        signal: AbortSignal.timeout(4_000),
      });
      if (response.ok) return;
      lastError = `Runner returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error(lastError);
}

async function main() {
  try {
    await docker([
      "run",
      "-d",
      "--name",
      containerName,
      "--label",
      "cloudagent.smoke=acp",
      "--security-opt",
      "seccomp=unconfined",
      "--shm-size",
      "2g",
      "--memory",
      "1g",
      "--cpus",
      "1",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      `SANDBOX_API_KEY=${apiKey}`,
      "-e",
      "WORKSPACE=/home/gem/workspace",
      "-e",
      `TZ=${process.env.TZ ?? "Asia/Shanghai"}`,
      "-p",
      "127.0.0.1::8080",
      image,
    ]);
    const portOutput = await docker(["port", containerName, "8080/tcp"]);
    const portMatch = portOutput.match(/:(\d+)$/);
    if (!portMatch) throw new Error("Docker did not publish the ACP smoke runner port");
    const hostPort = Number(portMatch[1]);
    const baseUrl = `http://127.0.0.1:${hostPort}`;
    await waitUntilReady(baseUrl);

    const runner: TaskRunner = {
      id: "00000000-0000-4000-8000-000000000901",
      taskId: "00000000-0000-4000-8000-000000000902",
      integrationId: null,
      projectMergePlanRunId: null,
      projectValidationRunId: null,
      provider: "aio-sandbox",
      containerName,
      image,
      status: "running",
      baseUrl,
      hostPort,
      workspacePath: "/tmp/cloudagent-acp-smoke",
      containerWorkspacePath: "/home/gem/workspace",
      credentialRef: "openbao://smoke",
      resourceLimits: { cpus: "1", memory: "1g" },
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await docker(["exec", containerName, "mkdir", "-p", runner.containerWorkspacePath]);
    await docker([
      "cp",
      path.join(repositoryRoot, "scripts/fixtures/mock-acp-agent.mjs"),
      `${containerName}:/tmp/mock-acp-agent.mjs`,
    ]);

    const events: string[] = [];
    const first = await runAcpSession({
      runner,
      connection,
      apiKey: "cloudagent-smoke-key-1234567890",
      prompt: "Run the ACP smoke test.",
      callbacks: {
        onEvent: async (event) => {
          events.push(event.eventType);
        },
        requestPermission: async () => ({ selectedOptionId: "allow-once" }),
      },
    });

    if (first.providerSessionId !== "mock-acp-session-1") {
      throw new Error(`Unexpected ACP session id: ${first.providerSessionId}`);
    }
    if (!first.finalMessage?.includes("Permission allow-once")) {
      throw new Error(`Unexpected ACP final message: ${first.finalMessage}`);
    }
    if (!events.includes("acp.permission_requested") || !events.includes("acp.agent_message_chunk")) {
      throw new Error(`Missing ACP events: ${events.join(", ")}`);
    }

    const resumed = await runAcpSession({
      runner,
      connection,
      apiKey: "cloudagent-smoke-key-1234567890",
      prompt: "Continue the ACP smoke test.",
      providerSessionId: first.providerSessionId,
      callbacks: {
        requestPermission: async () => ({ selectedOptionId: "allow-once" }),
      },
    });

    if (resumed.providerSessionId !== first.providerSessionId || resumed.stopReason !== "end_turn") {
      throw new Error(`ACP resume failed: ${JSON.stringify(resumed)}`);
    }

    const cancellationStartedAt = Date.now();
    const cancelled = await runAcpSession({
      runner,
      connection,
      apiKey: "cloudagent-smoke-key-1234567890",
      prompt: "Please cancel this ACP turn.",
      providerSessionId: first.providerSessionId,
      callbacks: {
        shouldCancel: async () => Date.now() - cancellationStartedAt > 150,
      },
    });
    if (cancelled.stopReason !== "cancelled") {
      throw new Error(`ACP cancellation failed: ${JSON.stringify(cancelled)}`);
    }

    console.log(JSON.stringify({
      providerSessionId: first.providerSessionId,
      firstStopReason: first.stopReason,
      resumedStopReason: resumed.stopReason,
      cancelledStopReason: cancelled.stopReason,
      eventCount: events.length,
    }));
  } finally {
    await docker(["rm", "-f", containerName]).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
