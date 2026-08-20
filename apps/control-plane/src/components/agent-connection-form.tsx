"use client";

import { useState } from "react";

import { createAgentConnectionAction } from "@/app/actions";

type AgentProtocol = "openai-compatible" | "acp" | "local";

export function AgentConnectionForm() {
  const [protocol, setProtocol] = useState<AgentProtocol>("openai-compatible");
  const usesModelApi = protocol === "openai-compatible";

  return (
    <form className="form" action={createAgentConnectionAction}>
      <div className="form-row">
        <label>
          Display name
          <input name="displayName" required minLength={2} defaultValue="My DeepSeek Agent" />
        </label>
        <label>
          Connection type
          <select
            name="protocol"
            value={protocol}
            onChange={(event) => setProtocol(event.target.value as AgentProtocol)}
          >
            <option value="openai-compatible">Model API (recommended)</option>
            <option value="acp">ACP Agent</option>
            <option value="local">Codex local adapter</option>
          </select>
        </label>
      </div>

      {usesModelApi ? (
        <>
          <div className="form-row">
            <label>
              Provider ID
              <input name="provider" required pattern="[a-z0-9-]+" defaultValue="deepseek" />
            </label>
            <label>
              Model
              <input name="model" required defaultValue="deepseek-chat" />
            </label>
          </div>
          <div className="form-row">
            <label>
              API Base URL
              <input
                name="apiBaseUrl"
                type="url"
                required
                defaultValue="https://api.deepseek.com"
                placeholder="https://api.deepseek.com"
              />
            </label>
            <label>
              Maximum tool rounds
              <input name="maxToolRounds" type="number" min={1} max={100} defaultValue={24} />
            </label>
          </div>
        </>
      ) : (
        <>
          <div className="form-row">
            <label>
              Provider ID
              <input
                name="provider"
                required
                pattern="[a-z0-9-]+"
                defaultValue={protocol === "local" ? "codex" : "opencode"}
              />
            </label>
            <label>
              Model (optional)
              <input name="model" placeholder="The Agent may use its default model" />
            </label>
          </div>
          <div className="form-row">
            <label>
              Command inside Runner
              <input
                name="launcherCommand"
                required
                defaultValue={protocol === "local" ? "codex" : "opencode"}
              />
            </label>
            <label>
              Credential environment variable
              <input
                name="credentialEnvironmentVariable"
                required
                defaultValue="OPENAI_API_KEY"
                pattern="[A-Z_][A-Z0-9_]*"
              />
            </label>
          </div>
          <label>
            Command arguments (one per line)
            <textarea
              name="launcherArguments"
              defaultValue={protocol === "acp" ? "acp" : ""}
            />
          </label>
        </>
      )}

      {usesModelApi ? (
        <input type="hidden" name="credentialEnvironmentVariable" value="OPENAI_API_KEY" />
      ) : null}
      <label>
        API Key
        <input
          type="password"
          name="apiKey"
          autoComplete="off"
          required
          minLength={20}
          placeholder="Credentials are stored only in OpenBao"
        />
      </label>
      <button className="button" type="submit">Register my Agent</button>
    </form>
  );
}
