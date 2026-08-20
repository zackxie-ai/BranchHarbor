import { writeFileSync } from "node:fs";
import readline from "node:readline";

const [independentTaskId, foundationTaskId, dependentTaskId] = process.argv.slice(2);
const sessionId = "mock-merge-plan-session-1";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(text) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "cloudagent-merge-plan-mock", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/load") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    let workspaceReadOnly = false;
    try {
      writeFileSync("merge-plan-agent-must-not-write.txt", "unexpected write\n");
    } catch {
      workspaceReadOnly = true;
    }
    if (!workspaceReadOnly) {
      throw new Error("Merge Planning Agent workspace was writable");
    }
    update(JSON.stringify({
      summary: "Analyze the independent task first, then the shared contract, then its consumer.",
      recommendedTaskIds: [independentTaskId, foundationTaskId, dependentTaskId],
      orderRationale: [
        { taskId: independentTaskId, reason: "It is semantically isolated from the shared contract." },
        { taskId: foundationTaskId, reason: "It defines the contract consumed by the dependent task." },
        { taskId: dependentTaskId, reason: "It must follow the foundation dependency." },
      ],
      semanticConflicts: [
        {
          taskIds: [foundationTaskId, dependentTaskId],
          severity: "warning",
          summary: "The dependent task consumes the contract introduced by the foundation task.",
          evidence: ["src/contract.ts exports the shared interface"],
          recommendation: "Merge and verify the foundation before integrating the consumer.",
        },
      ],
      uncertainties: [],
    }));
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
    return;
  }
  if (message.method === "session/cancel") {
    return;
  }
});
