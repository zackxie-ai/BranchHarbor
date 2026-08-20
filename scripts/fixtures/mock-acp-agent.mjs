import readline from "node:readline";

const sessionId = "mock-acp-session-1";
let pendingPromptId = null;

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
        agentInfo: { name: "cloudagent-mock", version: "1.0.0" },
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
    pendingPromptId = message.id;
    const prompt = message.params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    update(`Mock received: ${prompt}`);
    if (prompt.includes("cancel this ACP turn")) {
      return;
    }
    send({
      jsonrpc: "2.0",
      id: 900,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          toolCallId: "mock-tool-1",
          title: "Write mock result",
          status: "pending",
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    return;
  }

  if (message.method === "session/cancel") {
    if (pendingPromptId !== null) {
      send({
        jsonrpc: "2.0",
        id: pendingPromptId,
        result: { stopReason: "cancelled" },
      });
      pendingPromptId = null;
    }
    return;
  }

  if (message.id === 900 && pendingPromptId !== null) {
    const optionId = message.result?.outcome?.optionId ?? "cancelled";
    update(` Permission ${optionId}.`);
    send({
      jsonrpc: "2.0",
      id: pendingPromptId,
      result: { stopReason: "end_turn" },
    });
    pendingPromptId = null;
  }
});
