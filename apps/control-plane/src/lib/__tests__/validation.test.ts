import { describe, expect, it } from "vitest";

import { createAgentConnectionSchema, createProjectSchema } from "../validation";

const apiConnection = {
  displayName: "My DeepSeek Agent",
  provider: "deepseek",
  protocol: "openai-compatible",
  model: "deepseek-chat",
  apiBaseUrl: "https://api.deepseek.com",
  credentialEnvironmentVariable: "OPENAI_API_KEY",
  apiKey: "deepseek-test-key-1234567890",
};

describe("Agent connection validation", () => {
  it("accepts a model API connection without a launcher command", () => {
    const connection = createAgentConnectionSchema.parse({
      ...apiConnection,
      launcherCommand: null,
    });

    expect(connection.launcherCommand).toBe("");
    expect(connection.maxToolRounds).toBe(24);
  });

  it("still requires a launcher command for ACP connections", () => {
    const result = createAgentConnectionSchema.safeParse({
      ...apiConnection,
      provider: "opencode",
      protocol: "acp",
      launcherCommand: null,
      launcherArguments: ["acp"],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["launcherCommand"] }),
        ]),
      );
    }
  });
});

describe("Project validation", () => {
  it("normalizes a human-entered repository identifier", () => {
    const project = createProjectSchema.parse({
      name: "CloudAgent Project",
      slug: " My__Cloud--Project- ",
    });

    expect(project.slug).toBe("my-cloud-project");
  });

  it("allows CloudAgent to generate the identifier", () => {
    const project = createProjectSchema.parse({
      name: "Project with Unicode input",
      slug: "🚀",
    });

    expect(project.slug).toBeUndefined();
  });
});
