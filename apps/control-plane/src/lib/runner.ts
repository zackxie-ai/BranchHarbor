import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "./config";
import { AppError } from "./errors";
import { deleteSecret, readSecret, writeSecret } from "./openbao";
import {
  getIntegrationRunner,
  getProjectMergePlanRunner,
  getProjectValidationRunner,
  getTaskRunner,
  insertIntegrationRunner,
  insertProjectMergePlanRunner,
  insertProjectValidationRunner,
  insertTaskRunner,
  stopActiveTaskPreviewsForRunner,
  updateTaskRunner,
} from "./repositories";
import type { TaskRunner, VerificationResult } from "./types";

const execFileAsync = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("docker", args, {
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stderr?: string };
    throw new AppError(
      `Docker command failed: ${failed.stderr ?? failed.message}`,
      502,
      "RUNNER_DOCKER_FAILED",
    );
  }
}

async function waitUntilReady(baseUrl: string, apiKey: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastError = "Runner did not respond";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/docs`, {
        headers: { "X-AIO-API-Key": apiKey },
        signal: AbortSignal.timeout(4_000),
      });
      if (response.ok) {
        return;
      }
      lastError = `Runner returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new AppError(lastError, 504, "RUNNER_START_TIMEOUT");
}

async function ensureGitSafeDirectory(containerName: string): Promise<void> {
  await docker([
    "exec",
    containerName,
    "git",
    "config",
    "--global",
    "--add",
    "safe.directory",
    config.runner.containerWorkspacePath,
  ]);
}

async function launchRunner(input: {
  ownerType: "task" | "integration" | "merge-plan" | "project-validation";
  ownerId: string;
  workspacePath: string;
  projectId?: string;
}): Promise<TaskRunner> {
  const existing =
    input.ownerType === "task"
      ? await getTaskRunner(input.ownerId)
      : input.ownerType === "integration"
        ? await getIntegrationRunner(input.ownerId)
        : input.ownerType === "merge-plan"
          ? await getProjectMergePlanRunner(input.ownerId)
          : await getProjectValidationRunner(input.ownerId);
  if (existing && existing.status === "running") {
    await ensureGitSafeDirectory(existing.containerName);
    return existing;
  }
  if (existing?.status === "destroyed") {
    throw new AppError(
      "This runner was permanently destroyed",
      409,
      "RUNNER_DESTROYED",
    );
  }

  if (existing?.status === "stopped") {
    const secret = await readSecret(existing.credentialRef);
    await docker(["start", existing.containerName]);
    await ensureGitSafeDirectory(existing.containerName);
    if (!existing.baseUrl) {
      throw new AppError("Stopped runner has no recorded URL", 500, "RUNNER_URL_MISSING");
    }
    await waitUntilReady(existing.baseUrl, secret.api_key ?? "");
    return updateTaskRunner({ runnerId: existing.id, status: "running" });
  }

  const runnerId = existing?.id ?? randomUUID();
  const containerName =
    existing?.containerName ?? `cloudagent-${input.ownerType}-${input.ownerId.slice(0, 8)}`;
  const apiKey = randomBytes(32).toString("base64url");
  const credentialRef = existing?.credentialRef ?? `openbao://secret/runners/${runnerId}`;
  const containerWorkspacePath = input.ownerType === "merge-plan"
    ? "/home/gem/project"
    : config.runner.containerWorkspacePath;
  const recordInput = {
    id: runnerId,
    containerName,
    image: config.runner.image,
    workspacePath: input.workspacePath,
    containerWorkspacePath,
    credentialRef,
    resourceLimits: { memory: config.runner.memory, cpus: config.runner.cpus },
  };
  const runner = existing
    ? await updateTaskRunner({ runnerId: existing.id, status: "starting", lastError: null })
    : input.ownerType === "task"
      ? await insertTaskRunner({ ...recordInput, taskId: input.ownerId })
      : input.ownerType === "integration"
        ? await insertIntegrationRunner({ ...recordInput, integrationId: input.ownerId })
        : input.ownerType === "merge-plan"
          ? await insertProjectMergePlanRunner({
              ...recordInput,
              projectMergePlanRunId: input.ownerId,
            })
          : await insertProjectValidationRunner({
              ...recordInput,
              projectValidationRunId: input.ownerId,
            });

  try {
    await writeSecret(credentialRef, { api_key: apiKey });
    await docker(["rm", "-f", containerName]).catch(() => "");
    const workspaceMounts = input.ownerType === "merge-plan"
      ? [
          "-v",
          `${path.join(config.runtimeRoot, "projects", input.projectId!)}:${path.join(config.runtimeRoot, "projects", input.projectId!)}:ro`,
          "-v",
          `${input.workspacePath}:${containerWorkspacePath}:ro`,
        ]
      : [
          "-v",
          `${config.runtimeRoot}:${config.runtimeRoot}`,
          "-v",
          `${input.workspacePath}:${config.runner.containerWorkspacePath}`,
        ];
    await docker([
      "run",
      "-d",
      "--name",
      containerName,
      "--label",
      "cloudagent.runner=true",
      "--label",
      `cloudagent.${input.ownerType}_id=${input.ownerId}`,
      "--security-opt",
      "seccomp=unconfined",
      "--shm-size",
      "2g",
      "--memory",
      config.runner.memory,
      "--cpus",
      config.runner.cpus,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      `SANDBOX_API_KEY=${apiKey}`,
      "-e",
      `WORKSPACE=${config.runner.containerWorkspacePath}`,
      "-e",
      `TZ=${config.runner.timezone}`,
      "-p",
      "127.0.0.1::8080",
      ...workspaceMounts,
      config.runner.image,
    ]);
    await ensureGitSafeDirectory(containerName);
    const portOutput = await docker(["port", containerName, "8080/tcp"]);
    const portMatch = portOutput.match(/:(\d+)$/);
    if (!portMatch) {
      throw new AppError("Docker did not publish a runner port", 502, "RUNNER_PORT_MISSING");
    }
    const hostPort = Number(portMatch[1]);
    const baseUrl = `http://127.0.0.1:${hostPort}`;
    await waitUntilReady(baseUrl, apiKey);
    return updateTaskRunner({
      runnerId: runner.id,
      status: "running",
      baseUrl,
      hostPort,
    });
  } catch (error) {
    await updateTaskRunner({
      runnerId: runner.id,
      status: "failed",
      lastError: error instanceof Error ? error.message : String(error),
    });
    await docker(["rm", "-f", containerName]).catch(() => "");
    throw error;
  }
}

export function launchTaskRunner(taskId: string, workspacePath: string): Promise<TaskRunner> {
  return launchRunner({ ownerType: "task", ownerId: taskId, workspacePath });
}

export async function rebuildTaskRunnerAfterWorkspaceRestore(
  taskId: string,
  workspacePath: string,
): Promise<TaskRunner> {
  const existing = await getTaskRunner(taskId);
  if (!existing) return launchTaskRunner(taskId, workspacePath);
  if (existing.status === "destroyed") {
    throw new AppError(
      "A destroyed task runner cannot be rebuilt",
      409,
      "RUNNER_DESTROYED",
    );
  }
  await stopActiveTaskPreviewsForRunner(existing.id, "Workspace restored after host storage loss");
  await docker(["rm", "-f", existing.containerName]).catch(() => "");
  await updateTaskRunner({
    runnerId: existing.id,
    status: "failed",
    lastError: "Workspace restored; rebuilding runner",
  });
  return launchTaskRunner(taskId, workspacePath);
}

export function launchIntegrationRunner(
  integrationId: string,
  workspacePath: string,
): Promise<TaskRunner> {
  return launchRunner({ ownerType: "integration", ownerId: integrationId, workspacePath });
}

export function launchProjectMergePlanRunner(
  projectMergePlanRunId: string,
  projectId: string,
  workspacePath: string,
): Promise<TaskRunner> {
  return launchRunner({
    ownerType: "merge-plan",
    ownerId: projectMergePlanRunId,
    projectId,
    workspacePath,
  });
}

export function launchProjectValidationRunner(
  projectValidationRunId: string,
  workspacePath: string,
): Promise<TaskRunner> {
  return launchRunner({
    ownerType: "project-validation",
    ownerId: projectValidationRunId,
    workspacePath,
  });
}

export async function executeInRunner(
  runner: TaskRunner,
  command: string,
): Promise<{ exitCode: number; output: string }> {
  if (runner.status !== "running" || !runner.baseUrl) {
    throw new AppError("Runner is not available", 409, "RUNNER_NOT_RUNNING");
  }
  const secret = await readSecret(runner.credentialRef);
  const headers = {
    "Content-Type": "application/json",
    "X-AIO-API-Key": secret.api_key ?? "",
  };
  const response = await fetch(`${runner.baseUrl}/v1/bash/exec`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      command,
      exec_dir: runner.containerWorkspacePath,
      async_mode: true,
      hard_timeout: 180,
      max_output_length: 0,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new AppError(
      `Runner command request failed with HTTP ${response.status}`,
      502,
      "RUNNER_COMMAND_FAILED",
    );
  }
  const body = (await response.json()) as {
    success?: boolean;
    message?: string;
    data?: {
      session_id?: string;
      command_id?: string;
      status?: string;
      stdout?: string | null;
      stderr?: string | null;
      exit_code?: number | null;
      offset?: number;
      stderr_offset?: number;
    };
  };
  if (!body.success || !body.data?.session_id || !body.data.command_id) {
    throw new AppError(body.message ?? "Runner command failed", 502, "RUNNER_COMMAND_FAILED");
  }
  let status = body.data.status ?? "running";
  let exitCode = body.data.exit_code ?? null;
  let offset = body.data.offset ?? 0;
  let stderrOffset = body.data.stderr_offset ?? 0;
  const stdout: string[] = body.data.stdout ? [body.data.stdout] : [];
  const stderr: string[] = body.data.stderr ? [body.data.stderr] : [];
  const deadline = Date.now() + 190_000;
  while (["pending", "running"].includes(status) && Date.now() < deadline) {
    const outputResponse = await fetch(`${runner.baseUrl}/v1/bash/output`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: body.data.session_id,
        command_id: body.data.command_id,
        offset,
        stderr_offset: stderrOffset,
        wait: true,
        wait_timeout: 20,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!outputResponse.ok) {
      throw new AppError(
        `Runner command output request failed with HTTP ${outputResponse.status}`,
        502,
        "RUNNER_COMMAND_FAILED",
      );
    }
    const outputBody = (await outputResponse.json()) as {
      success?: boolean;
      message?: string;
      data?: {
        stdout?: string;
        stderr?: string;
        offset?: number;
        stderr_offset?: number;
        command?: { status?: string; exit_code?: number | null } | null;
      };
    };
    if (!outputBody.success || !outputBody.data) {
      throw new AppError(
        outputBody.message ?? "Runner command output failed",
        502,
        "RUNNER_COMMAND_FAILED",
      );
    }
    if (outputBody.data.stdout) stdout.push(outputBody.data.stdout);
    if (outputBody.data.stderr) stderr.push(outputBody.data.stderr);
    offset = outputBody.data.offset ?? offset;
    stderrOffset = outputBody.data.stderr_offset ?? stderrOffset;
    status = outputBody.data.command?.status ?? status;
    exitCode = outputBody.data.command?.exit_code ?? exitCode;
  }
  if (["pending", "running"].includes(status)) {
    throw new AppError("Runner command exceeded its execution deadline", 504, "RUNNER_COMMAND_TIMEOUT");
  }
  const statusMessage = status === "completed" ? "" : `Command ended with status ${status}`;
  return {
    exitCode: exitCode ?? 1,
    output: [...stdout, ...stderr, statusMessage].filter(Boolean).join("\n"),
  };
}

interface RunnerApiResponse<T> {
  success?: boolean;
  message?: string;
  data?: T | null;
}

export interface RunnerPreviewProcessState {
  status: "running" | "completed" | "no_change_timeout" | "hard_timeout" | "terminated";
  output: string;
  exitCode: number | null;
}

function runnerPreviewLogPath(sessionId: string): string {
  return `/tmp/${sessionId}.log`;
}

async function runnerApiRequest<T>(
  runner: TaskRunner,
  pathname: string,
  options: { method?: "GET" | "POST" | "DELETE"; body?: Record<string, unknown> } = {},
  allowNotFound = false,
): Promise<T | null> {
  if (runner.status !== "running" || !runner.baseUrl) {
    throw new AppError("Runner is not available", 409, "RUNNER_NOT_RUNNING");
  }
  const secret = await readSecret(runner.credentialRef);
  const response = await fetch(`${runner.baseUrl}${pathname}`, {
    method: options.method ?? "POST",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      "X-AIO-API-Key": secret.api_key ?? "",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (allowNotFound && response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new AppError(
      `Runner request failed with HTTP ${response.status}`,
      502,
      "RUNNER_REQUEST_FAILED",
    );
  }
  const body = (await response.json()) as RunnerApiResponse<T>;
  if (!body.success || body.data === undefined) {
    throw new AppError(body.message ?? "Runner request failed", 502, "RUNNER_REQUEST_FAILED");
  }
  return body.data ?? null;
}

export function runnerPreviewUrl(runner: TaskRunner, port: number, previewId: string): string {
  if (!runner.baseUrl || runner.status !== "running") {
    throw new AppError("Runner is not running", 409, "RUNNER_NOT_RUNNING");
  }
  const url = new URL(runner.baseUrl);
  url.hostname = `${port}-${previewId.slice(0, 12)}.${config.runner.previewHostSuffix}`;
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function startRunnerPreviewProcess(
  runner: TaskRunner,
  input: { sessionId: string; command: string; port: number },
): Promise<void> {
  await runnerApiRequest<{ session_id: string }>(runner, "/v1/shell/sessions/create", {
    body: {
      id: input.sessionId,
      exec_dir: runner.containerWorkspacePath,
      no_change_timeout: 86_400,
    },
  });
  try {
    await runnerApiRequest<{ status: string }>(runner, "/v1/shell/write", {
      body: {
        id: input.sessionId,
        input: `export PORT=${input.port}; export HOST=0.0.0.0; export HOSTNAME=0.0.0.0; : > ${runnerPreviewLogPath(input.sessionId)}; (${input.command}) > ${runnerPreviewLogPath(input.sessionId)} 2>&1`,
        press_enter: true,
      },
    });
  } catch (error) {
    await stopRunnerPreviewProcess(runner, input.sessionId).catch(() => undefined);
    throw error;
  }
}

export async function readRunnerPreviewProcess(
  runner: TaskRunner,
  sessionId: string,
): Promise<RunnerPreviewProcessState> {
  const data = await runnerApiRequest<{
    status: RunnerPreviewProcessState["status"];
    output?: string;
    exit_code?: number | null;
  }>(runner, "/v1/shell/view", { body: { id: sessionId } }, true);
  if (!data) {
    return { status: "terminated", output: "", exitCode: null };
  }
  const log = await runnerApiRequest<{ content?: string }>(runner, "/v1/file/read", {
    body: { file: runnerPreviewLogPath(sessionId) },
  }).catch(() => null);
  return {
    status: data.status,
    output: log?.content ?? data.output ?? "",
    exitCode: data.exit_code ?? null,
  };
}

export async function waitForRunnerPreview(previewUrl: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastError = "Application has not responded yet";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(previewUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(3_000),
      });
      const status = response.status;
      await response.body?.cancel();
      if (status < 500) {
        return;
      }
      lastError = `Preview returned HTTP ${status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new AppError(lastError, 504, "TASK_PREVIEW_START_TIMEOUT");
}

export async function stopRunnerPreviewProcess(
  runner: TaskRunner,
  sessionId: string,
): Promise<void> {
  await runnerApiRequest(runner, "/v1/shell/kill", { body: { id: sessionId } }, true).catch(
    (error) => {
      if (error instanceof AppError && error.statusCode === 404) {
        return null;
      }
      throw error;
    },
  );
  await runnerApiRequest(
    runner,
    `/v1/shell/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
    true,
  ).catch(() => null);
}

export async function runVerificationInRunner(
  commands: string[],
  runner: TaskRunner,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const command of commands) {
    const startedAt = Date.now();
    try {
      const result = await executeInRunner(runner, command);
      results.push({
        command,
        exitCode: result.exitCode,
        output: result.output.trim().slice(-20_000),
        durationMs: Date.now() - startedAt,
      });
      if (result.exitCode !== 0) {
        break;
      }
    } catch (error) {
      results.push({
        command,
        exitCode: 1,
        output: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      break;
    }
  }
  return results;
}

export async function runnerAccessUrl(
  runner: TaskRunner,
  surface: "home" | "code-server" | "vnc" = "home",
): Promise<string> {
  if (!runner.baseUrl || runner.status !== "running") {
    throw new AppError("Runner is not running", 409, "RUNNER_NOT_RUNNING");
  }
  const secret = await readSecret(runner.credentialRef);
  const pathname =
    surface === "code-server"
      ? "/code-server/"
      : surface === "vnc"
        ? "/vnc/index.html"
        : "/";
  const url = new URL(pathname, runner.baseUrl);
  url.searchParams.set("api_key", secret.api_key ?? "");
  if (surface === "vnc") {
    url.searchParams.set("autoconnect", "true");
  }
  return url.toString();
}

export async function stopRunner(runner: TaskRunner): Promise<void> {
  if (runner.status === "running") {
    await docker(["stop", "--time", "10", runner.containerName]);
  }
  await stopActiveTaskPreviewsForRunner(runner.id, "Task Runner stopped");
  await updateTaskRunner({ runnerId: runner.id, status: "stopped" });
}

export async function destroyRunner(runner: TaskRunner): Promise<void> {
  await docker(["rm", "-f", runner.containerName]).catch(() => "");
  await stopActiveTaskPreviewsForRunner(runner.id, "Task Runner destroyed");
  await deleteSecret(runner.credentialRef).catch(() => undefined);
  await updateTaskRunner({ runnerId: runner.id, status: "destroyed" });
}
