import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import readline from "node:readline";

const sessionId = "mock-integration-session-1";

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
        agentInfo: { name: "branchharbor-integration-mock", version: "1.0.0" },
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
    writeFileSync("conflict.txt", "resolved main + task\n");
    execFileSync("git", ["add", "conflict.txt"]);
    execFileSync("git", ["commit", "-m", "Resolve integration conflict"]);
    update("Resolved the conflict and created the integration commit.");
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
