import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";

import {
  client as createAcpClient,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type {
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import { AppError } from "./errors";
import { executeInRunner } from "./runner";
import type { AgentConnection, TaskRunner } from "./types";

export interface AgentEventPayload {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface ParsedAgentOutput {
  events: AgentEventPayload[];
  finalMessage: string | null;
  providerSessionId: string | null;
  stopReason?: string | null;
  transportMetadata?: Record<string, unknown>;
}

export interface AgentSessionCallbacks {
  onEvent?: (event: AgentEventPayload) => Promise<void>;
  requestPermission?: (input: {
    providerRequestId: string;
    sessionId: string;
    toolCall: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
  }) => Promise<{ selectedOptionId: string | null }>;
  shouldCancel?: () => Promise<boolean>;
}

export function parseCodexJsonLines(output: string): ParsedAgentOutput {
  const events: AgentEventPayload[] = [];
  let finalMessage: string | null = null;
  let providerSessionId: string | null = null;

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      payload = { type: "raw_output", text: line };
    }
    const eventType = typeof payload.type === "string" ? payload.type : "unknown";
    events.push({ eventType, payload });

    if (eventType === "thread.started" && typeof payload.thread_id === "string") {
      providerSessionId = payload.thread_id;
    }
    const item = payload.item;
    if (
      eventType === "item.completed" &&
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "agent_message" &&
      "text" in item &&
      typeof item.text === "string"
    ) {
      finalMessage = item.text;
    }
  }

  return { events, finalMessage, providerSessionId };
}

async function emitEvent(
  callbacks: AgentSessionCallbacks | undefined,
  event: AgentEventPayload,
): Promise<void> {
  await callbacks?.onEvent?.(event);
}

function spawnDockerAgent(input: {
  runner: TaskRunner;
  environmentFile: string;
  command: string;
  args: string[];
  interactive?: boolean;
}) {
  return spawn(
    "docker",
    [
      "exec",
      ...(input.interactive ? ["-i"] : []),
      "--env-file",
      input.environmentFile,
      "--workdir",
      input.runner.containerWorkspacePath,
      input.runner.containerName,
      input.command,
      ...input.args,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

export async function runCodexSession(input: {
  runner: TaskRunner;
  apiKey: string;
  prompt: string;
  model?: string | null;
  providerSessionId?: string | null;
  callbacks?: AgentSessionCallbacks;
}): Promise<ParsedAgentOutput> {
  if (input.runner.status !== "running") {
    throw new AppError("Task runner is not running", 409, "RUNNER_NOT_RUNNING");
  }

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "branchharbor-codex-"));
  const environmentFile = path.join(tempDirectory, "agent.env");
  await writeFile(environmentFile, `OPENAI_API_KEY=${input.apiKey}\n`, { mode: 0o600 });

  const args = input.providerSessionId
    ? [
        "exec",
        "resume",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
      ]
    : [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C",
        input.runner.containerWorkspacePath,
      ];
  if (input.model) {
    args.push("-m", input.model);
  }
  if (input.providerSessionId) {
    args.push(input.providerSessionId);
  }
  args.push(input.prompt);

  const child = spawnDockerAgent({
    runner: input.runner,
    environmentFile,
    command: "codex",
    args,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const lines = createInterface({ input: child.stdout });
  const events: AgentEventPayload[] = [];
  let finalMessage: string | null = null;
  let providerSessionId: string | null = null;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const exitPromise = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });
  let cancellationCheckRunning = false;
  const cancellationTimer = setInterval(() => {
    if (cancellationCheckRunning || !input.callbacks?.shouldCancel) {
      return;
    }
    cancellationCheckRunning = true;
    void input.callbacks.shouldCancel()
      .then(async (cancelled) => {
        if (cancelled) {
          await emitEvent(input.callbacks, {
            eventType: "session.cancelled",
            payload: { provider: "codex", providerSessionId },
          });
          child.kill("SIGTERM");
        }
      })
      .finally(() => {
        cancellationCheckRunning = false;
      });
  }, 750);

  try {
    for await (const line of lines) {
      const parsed = parseCodexJsonLines(String(line));
      const event = parsed.events[0];
      if (!event) {
        continue;
      }
      events.push(event);
      providerSessionId = parsed.providerSessionId ?? providerSessionId;
      finalMessage = parsed.finalMessage ?? finalMessage;
      await emitEvent(input.callbacks, event);
    }
    await exitPromise;
    if (exitCode !== 0) {
      const details = [stderr.trim(), finalMessage].filter(Boolean).join("\n");
      throw new AppError(
        details || `Codex exited with ${exitSignal ?? `code ${exitCode}`}`,
        502,
        "AGENT_SESSION_FAILED",
      );
    }
    return { events, finalMessage, providerSessionId };
  } catch (error) {
    child.kill("SIGTERM");
    const failed = error instanceof Error ? error.message : String(error);
    throw new AppError(
      [failed, stderr.trim()].filter(Boolean).join("\n"),
      502,
      "AGENT_SESSION_FAILED",
    );
  } finally {
    clearInterval(cancellationTimer);
    lines.close();
    child.kill("SIGTERM");
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function contentText(content: unknown): string | null {
  if (!content || typeof content !== "object") {
    return null;
  }
  const candidate = content as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : null;
}

function sessionUpdateText(update: SessionUpdate): string | null {
  if (update.sessionUpdate !== "agent_message_chunk") {
    return null;
  }
  return contentText(update.content);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

type OpenAiCompatibleMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAiCompatibleToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAiCompatibleToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAiCompatibleResponse {
  id?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: OpenAiCompatibleToolCall[];
    };
  }>;
}

const OPENAI_COMPATIBLE_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a shell command in the isolated BranchHarbor workspace. Use it to inspect files, edit code, run tests, and create Git commits.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The complete shell command to execute in the workspace.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
] as const;

function openAiCompatibleEndpoint(apiBaseUrl: string): string {
  const normalized = apiBaseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

function truncateToolOutput(output: string, maxLength = 40_000): string {
  if (output.length <= maxLength) return output;
  const half = Math.floor(maxLength / 2);
  return `${output.slice(0, half)}\n\n[BranchHarbor truncated ${output.length - maxLength} characters]\n\n${output.slice(-half)}`;
}

async function fetchOpenAiCompatibleResponse(input: {
  endpoint: string;
  apiKey: string;
  model: string;
  messages: OpenAiCompatibleMessage[];
  callbacks?: AgentSessionCallbacks;
}): Promise<OpenAiCompatibleResponse> {
  const controller = new AbortController();
  let cancelled = false;
  let cancellationCheckRunning = false;
  const timeout = setTimeout(() => controller.abort(), 120_000);
  const cancellationTimer = setInterval(() => {
    if (cancellationCheckRunning || !input.callbacks?.shouldCancel) return;
    cancellationCheckRunning = true;
    void input.callbacks.shouldCancel()
      .then((shouldCancel) => {
        if (shouldCancel) {
          cancelled = true;
          controller.abort();
        }
      })
      .finally(() => {
        cancellationCheckRunning = false;
      });
  }, 500);

  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        tools: OPENAI_COMPATIBLE_TOOLS,
        tool_choice: "auto",
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 4_000);
      throw new AppError(
        `Model API returned HTTP ${response.status}${details ? `: ${details}` : ""}`,
        502,
        "MODEL_API_REQUEST_FAILED",
      );
    }
    return (await response.json()) as OpenAiCompatibleResponse;
  } catch (error) {
    if (cancelled) {
      throw new AppError("Agent session was cancelled", 409, "AGENT_SESSION_CANCELLED");
    }
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AppError("Model API request timed out", 504, "MODEL_API_TIMEOUT");
    }
    throw new AppError(
      error instanceof Error ? error.message : String(error),
      502,
      "MODEL_API_REQUEST_FAILED",
    );
  } finally {
    clearTimeout(timeout);
    clearInterval(cancellationTimer);
  }
}

export async function runOpenAiCompatibleSession(input: {
  runner: TaskRunner;
  connection: AgentConnection & { credentialRef: string | null };
  apiKey: string;
  prompt: string;
  callbacks?: AgentSessionCallbacks;
}): Promise<ParsedAgentOutput> {
  if (input.runner.status !== "running") {
    throw new AppError("Task runner is not running", 409, "RUNNER_NOT_RUNNING");
  }
  if (!input.connection.apiBaseUrl || !input.connection.model) {
    throw new AppError(
      "OpenAI-compatible Agent API URL or model is missing",
      409,
      "MODEL_API_CONFIG_MISSING",
    );
  }

  const endpoint = openAiCompatibleEndpoint(input.connection.apiBaseUrl);
  const events: AgentEventPayload[] = [];
  const messages: OpenAiCompatibleMessage[] = [
    {
      role: "system",
      content: [
        "You are a coding Agent hosted by BranchHarbor.",
        "Use run_shell to inspect and change the repository in the isolated workspace.",
        "Follow the user's task policy exactly, verify your work, and report the concrete result.",
        "Do not claim a command succeeded unless you observed its output.",
      ].join(" "),
    },
    { role: "user", content: input.prompt },
  ];
  let providerSessionId: string | null = null;

  const appendEvent = async (event: AgentEventPayload): Promise<void> => {
    events.push(event);
    await emitEvent(input.callbacks, event);
  };

  for (let round = 1; round <= input.connection.maxToolRounds; round += 1) {
    if (await input.callbacks?.shouldCancel?.()) {
      throw new AppError("Agent session was cancelled", 409, "AGENT_SESSION_CANCELLED");
    }
    const response = await fetchOpenAiCompatibleResponse({
      endpoint,
      apiKey: input.apiKey,
      model: input.connection.model,
      messages,
      callbacks: input.callbacks,
    });
    providerSessionId = response.id ?? providerSessionId;
    const choice = response.choices?.[0];
    const assistant = choice?.message;
    if (!assistant) {
      throw new AppError(
        "Model API response did not contain an assistant message",
        502,
        "MODEL_API_INVALID_RESPONSE",
      );
    }
    const toolCalls = assistant.tool_calls ?? [];
    const content = assistant.content ?? null;
    await appendEvent({
      eventType: "api.response",
      payload: {
        providerSessionId,
        round,
        finishReason: choice.finish_reason ?? null,
        toolCallCount: toolCalls.length,
      },
    });
    if (content) {
      await appendEvent({
        eventType: "api.assistant_message",
        payload: { round, text: content },
      });
    }
    messages.push({
      role: "assistant",
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (toolCalls.length === 0) {
      await appendEvent({
        eventType: "api.session_completed",
        payload: { providerSessionId, round, finishReason: choice.finish_reason ?? null },
      });
      return {
        events,
        finalMessage: content,
        providerSessionId,
        stopReason: choice.finish_reason ?? "end_turn",
        transportMetadata: {
          protocol: "openai-compatible",
          apiBaseUrl: input.connection.apiBaseUrl,
          model: input.connection.model,
          rounds: round,
        },
      };
    }

    for (const toolCall of toolCalls) {
      if (await input.callbacks?.shouldCancel?.()) {
        throw new AppError("Agent session was cancelled", 409, "AGENT_SESSION_CANCELLED");
      }
      await appendEvent({
        eventType: "api.tool_call",
        payload: {
          round,
          toolCallId: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      });
      let result: { exitCode: number; output: string };
      try {
        const args = JSON.parse(toolCall.function.arguments) as { command?: unknown };
        if (toolCall.function.name !== "run_shell" || typeof args.command !== "string") {
          throw new Error("Unsupported tool call or missing command");
        }
        if (args.command.length > 20_000) {
          throw new Error("Shell command exceeds the 20,000 character limit");
        }
        result = await executeInRunner(input.runner, args.command);
      } catch (error) {
        result = {
          exitCode: 1,
          output: `BranchHarbor tool error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const toolContent = truncateToolOutput(
        JSON.stringify({ exitCode: result.exitCode, output: result.output }),
      );
      await appendEvent({
        eventType: "api.tool_result",
        payload: {
          round,
          toolCallId: toolCall.id,
          exitCode: result.exitCode,
          output: truncateToolOutput(result.output, 8_000),
        },
      });
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: toolContent });
    }
  }

  throw new AppError(
    `Agent exceeded the configured ${input.connection.maxToolRounds} tool rounds`,
    409,
    "AGENT_TOOL_ROUND_LIMIT",
  );
}

export async function runAcpSession(input: {
  runner: TaskRunner;
  connection: AgentConnection & { credentialRef: string | null };
  apiKey: string;
  prompt: string;
  providerSessionId?: string | null;
  callbacks?: AgentSessionCallbacks;
}): Promise<ParsedAgentOutput> {
  if (input.runner.status !== "running") {
    throw new AppError("Task runner is not running", 409, "RUNNER_NOT_RUNNING");
  }
  if (!input.connection.launcherCommand) {
    throw new AppError("ACP Agent launcher command is missing", 409, "AGENT_LAUNCHER_MISSING");
  }

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "branchharbor-acp-"));
  const environmentFile = path.join(tempDirectory, "agent.env");
  await writeFile(
    environmentFile,
    `${input.connection.credentialEnvironmentVariable}=${input.apiKey}\n`,
    { mode: 0o600 },
  );

  const child = spawnDockerAgent({
    runner: input.runner,
    environmentFile,
    command: input.connection.launcherCommand,
    args: input.connection.launcherArguments,
    interactive: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );
  const events: AgentEventPayload[] = [];
  let finalMessage = "";
  let providerSessionId: string | null = input.providerSessionId ?? null;
  let stopReason: string | null = null;
  let exitCode: number | null = null;
  const exitPromise = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      exitCode = code;
      resolve();
    });
  });

  const appendEvent = async (event: AgentEventPayload): Promise<void> => {
    events.push(event);
    await emitEvent(input.callbacks, event);
  };

  const client = createAcpClient({ name: "BranchHarbor" })
    .onNotification("session/update", async ({ params }) => {
      if (providerSessionId && params.sessionId !== providerSessionId) {
        return;
      }
      const update = params.update;
      const text = sessionUpdateText(update);
      if (text) {
        finalMessage += text;
      }
      await appendEvent({
        eventType: `acp.${update.sessionUpdate}`,
        payload: asRecord(update),
      });
    })
    .onRequest("session/request_permission", async ({ params, requestId }) => {
      const toolCall = asRecord(params.toolCall);
      const options = params.options.map((option) => asRecord(option));
      await appendEvent({
        eventType: "acp.permission_requested",
        payload: {
          providerRequestId: String(requestId),
          sessionId: params.sessionId,
          toolCall,
          options,
        },
      });
      const decision = await input.callbacks?.requestPermission?.({
        providerRequestId: String(requestId),
        sessionId: params.sessionId,
        toolCall,
        options,
      });
      const response: RequestPermissionResponse = decision?.selectedOptionId
        ? { outcome: { outcome: "selected", optionId: decision.selectedOptionId } }
        : { outcome: { outcome: "cancelled" } };
      await appendEvent({
        eventType: "acp.permission_resolved",
        payload: {
          providerRequestId: String(requestId),
          outcome: response.outcome,
        },
      });
      return response;
    });

  try {
    await client.connectWith(stream, async (agent) => {
      const initialization = await agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "BranchHarbor", version: "0.1.0" },
      });
      await appendEvent({
        eventType: "acp.initialized",
        payload: { protocolVersion: initialization.protocolVersion, capabilities: initialization.agentCapabilities ?? {} },
      });

      let sessionMetadata: Record<string, unknown> = {};
      if (providerSessionId) {
        const loaded = await agent.request("session/load", {
          sessionId: providerSessionId,
          cwd: input.runner.containerWorkspacePath,
          mcpServers: [],
        });
        sessionMetadata = asRecord(loaded);
      } else {
        const created = await agent.request("session/new", {
          cwd: input.runner.containerWorkspacePath,
          mcpServers: [],
        });
        providerSessionId = created.sessionId;
        sessionMetadata = asRecord(created);
      }
      await appendEvent({
        eventType: "acp.session_started",
        payload: {
          providerSessionId,
          resumed: Boolean(input.providerSessionId),
          sessionMetadata,
        },
      });

      let cancellationCheckRunning = false;
      const cancellationTimer = setInterval(() => {
        if (cancellationCheckRunning || !input.callbacks?.shouldCancel || !providerSessionId) {
          return;
        }
        cancellationCheckRunning = true;
        void input.callbacks.shouldCancel()
          .then(async (cancelled) => {
            if (cancelled && providerSessionId) {
              await agent.notify("session/cancel", { sessionId: providerSessionId });
            }
          })
          .finally(() => {
            cancellationCheckRunning = false;
          });
      }, 750);

      try {
        const response = await agent.request("session/prompt", {
          sessionId: providerSessionId,
          prompt: [{ type: "text", text: input.prompt }],
        });
        stopReason = response.stopReason;
      } finally {
        clearInterval(cancellationTimer);
      }
      await appendEvent({
        eventType: "acp.prompt_stopped",
        payload: { providerSessionId, stopReason },
      });
    });
    child.stdin.end();
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (exitCode === null) {
      child.kill("SIGTERM");
      await exitPromise;
    }
    if (exitCode !== null && exitCode !== 0) {
      throw new AppError(
        stderr.trim() || `ACP Agent exited with code ${exitCode}`,
        502,
        "AGENT_SESSION_FAILED",
      );
    }
    return {
      events,
      finalMessage: finalMessage || null,
      providerSessionId,
      stopReason,
      transportMetadata: { protocol: "acp", launcherCommand: input.connection.launcherCommand },
    };
  } catch (error) {
    child.kill("SIGTERM");
    const failed = error instanceof Error ? error.message : String(error);
    throw new AppError(
      [failed, stderr.trim()].filter(Boolean).join("\n"),
      502,
      "AGENT_SESSION_FAILED",
    );
  } finally {
    child.kill("SIGTERM");
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
