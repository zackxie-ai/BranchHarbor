import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { deleteSecret } from "../apps/control-plane/src/lib/openbao";
import {
  getTask,
  getTaskRunner,
  insertProject,
  insertTask,
  listAgentCredentialLeases,
  updateTaskWorkspace,
} from "../apps/control-plane/src/lib/repositories";
import { destroyRunner } from "../apps/control-plane/src/lib/runner";
import { createAgentConnection, runTaskAgent } from "../apps/control-plane/src/lib/services";

const execFileAsync = promisify(execFile);
const ownerId = randomUUID();
const projectId = randomUUID();
const runtimePath = path.join(config.runtimeRoot, "openai-compatible-agent-smoke", projectId);
const apiKey = `cloudagent-openai-compatible-${randomUUID()}`;
const requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = [];

async function readRequestBody(request: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function main() {
  let connectionId: string | null = null;
  const server = createServer((request, response) => {
    void readRequestBody(request)
      .then((body) => {
        requests.push({ authorization: request.headers.authorization, body });
        response.writeHead(200, { "Content-Type": "application/json" });
        if (requests.length === 1) {
          response.end(JSON.stringify({
            id: "mock-api-agent-turn-1",
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{
                  id: "call_write_proof",
                  type: "function",
                  function: {
                    name: "run_shell",
                    arguments: JSON.stringify({
                      command: [
                        "printf 'API agent works\\n' > API_AGENT.md",
                        "git config user.email 'api-agent@cloudagent.local'",
                        "git config user.name 'CloudAgent API Agent'",
                        "git add API_AGENT.md",
                        "git commit -m 'Add API agent proof'",
                      ].join(" && "),
                    }),
                  },
                }],
              },
            }],
          }));
          return;
        }
        response.end(JSON.stringify({
          id: "mock-api-agent-turn-2",
          choices: [{
            finish_reason: "stop",
            message: { content: "Created API_AGENT.md and committed the change." },
          }],
        }));
      })
      .catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock API server has no port");

  try {
    await mkdir(runtimePath, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: runtimePath });
    await execFileAsync("git", ["config", "user.email", "smoke@cloudagent.local"], { cwd: runtimePath });
    await execFileAsync("git", ["config", "user.name", "CloudAgent Smoke"], { cwd: runtimePath });
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "Initial commit"], { cwd: runtimePath });
    const { stdout: baseCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: runtimePath });

    await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
      ownerId,
      `openai-compatible-${ownerId.slice(0, 8)}@cloudagent.local`,
      "OpenAI Compatible Agent Owner",
    ]);
    await query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
      [config.organizationId, ownerId],
    );
    await insertProject({
      id: projectId,
      name: "OpenAI Compatible Agent Smoke",
      slug: `openai-compatible-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `openai-compatible-${projectId.slice(0, 8)}`,
      repositoryUrl: runtimePath,
      localRepositoryPath: runtimePath,
      actorId: ownerId,
    });
    const connection = await createAgentConnection({
      displayName: "Mock API Agent",
      provider: "mock-openai-compatible",
      protocol: "openai-compatible",
      model: "mock-coder",
      apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      maxToolRounds: 4,
      credentialEnvironmentVariable: "OPENAI_API_KEY",
      apiKey,
    }, ownerId);
    connectionId = connection.id;
    const task = await insertTask({
      projectId,
      title: "Prove a model API can act as an Agent",
      description: "Create API_AGENT.md through the hosted tool loop.",
      acceptanceCriteria: "The file exists in a Git commit.",
      verificationCommands: [],
      expectedChangeScopes: ["API_AGENT.md"],
      assignedUserId: ownerId,
      agentConnectionId: connection.id,
      actorId: ownerId,
    });
    await updateTaskWorkspace({
      taskId: task.id,
      baseCommit: baseCommit.trim(),
      branchName: `task/${task.id}`,
      worktreePath: runtimePath,
    });

    const session = await runTaskAgent(
      task.id,
      { prompt: "Create the requested proof file and commit it." },
      ownerId,
    );
    const runner = await getTaskRunner(task.id);
    if (runner) await destroyRunner(runner);

    if (session.status !== "completed" || !session.finalMessage?.includes("API_AGENT.md")) {
      throw new Error(`API Agent session did not complete: ${JSON.stringify(session)}`);
    }
    if ((await readFile(path.join(runtimePath, "API_AGENT.md"), "utf8")) !== "API agent works\n") {
      throw new Error("API Agent did not create the expected file");
    }
    const { stdout: commitSubject } = await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: runtimePath });
    if (commitSubject.trim() !== "Add API agent proof") {
      throw new Error(`API Agent did not create the expected commit: ${commitSubject}`);
    }
    if (requests.length !== 2 || requests.some((item) => item.authorization !== `Bearer ${apiKey}`)) {
      throw new Error(`Mock API received invalid requests: ${JSON.stringify(requests)}`);
    }
    const secondMessages = requests[1]?.body.messages;
    if (!Array.isArray(secondMessages) || !secondMessages.some(
      (message) => typeof message === "object" && message !== null && "role" in message && message.role === "tool",
    )) {
      throw new Error("Tool result was not returned to the model API");
    }
    const eventRows = await query<{ event_type: string }>(
      "SELECT event_type FROM agent_events WHERE session_id = $1 ORDER BY sequence_number",
      [session.id],
    );
    for (const eventType of ["api.tool_call", "api.tool_result", "api.session_completed"]) {
      if (!eventRows.some((event) => event.event_type === eventType)) {
        throw new Error(`Missing persisted Agent event: ${eventType}`);
      }
    }
    const leases = await listAgentCredentialLeases(ownerId);
    if (leases.length !== 1 || leases[0]?.status !== "released") {
      throw new Error(`Credential lease was not released: ${JSON.stringify(leases)}`);
    }
    const [connectionRecord] = await query<{ record: string }>(
      "SELECT to_jsonb(agent_connections)::TEXT AS record FROM agent_connections WHERE id = $1",
      [connection.id],
    );
    if (connectionRecord?.record.includes(apiKey)) {
      throw new Error("API Key leaked into PostgreSQL");
    }
    if ((await getTask(task.id)).status !== "active") {
      throw new Error("Task did not transition to active after API Agent completion");
    }

    console.log(JSON.stringify({
      modelApiRequests: requests.length,
      bearerCredentialUsed: true,
      toolCallExecuted: true,
      gitCommitCreated: true,
      eventsPersisted: eventRows.map((event) => event.event_type),
      credentialLeaseReleased: true,
      apiKeyStoredOutsidePostgres: true,
    }));
  } finally {
    const runnerRows = await query<{ task_id: string }>(
      "SELECT task_id FROM task_runners WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)",
      [projectId],
    ).catch(() => []);
    for (const row of runnerRows) {
      const runner = await getTaskRunner(row.task_id).catch(() => null);
      if (runner && runner.status !== "destroyed") await destroyRunner(runner).catch(() => undefined);
    }
    if (connectionId) {
      await deleteSecret(`openbao://secret/agent-connections/${connectionId}`).catch(() => undefined);
    }
    await query("DELETE FROM audit_events WHERE project_id = $1 OR actor_id = $2", [projectId, ownerId]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    if (connectionId) {
      await query("DELETE FROM agent_connections WHERE id = $1", [connectionId]).catch(() => undefined);
    }
    await query("DELETE FROM memberships WHERE user_id = $1", [ownerId]).catch(() => undefined);
    await query("DELETE FROM users WHERE id = $1", [ownerId]).catch(() => undefined);
    await rm(runtimePath, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
