import { describe, expect, it } from "vitest";

import { parseCodexJsonLines } from "../agent-gateway";
import { assertChangeRequestTransition, assertTaskTransition } from "../domain";

describe("CloudAgent workflow state machine", () => {
  it("allows a task to move through workspace, submission, integration, and merge", () => {
    expect(() => assertTaskTransition("draft", "workspace_ready")).not.toThrow();
    expect(() => assertTaskTransition("workspace_ready", "submitted")).not.toThrow();
    expect(() => assertTaskTransition("submitted", "integrating")).not.toThrow();
    expect(() => assertTaskTransition("integrating", "merged")).not.toThrow();
  });

  it("prevents direct task completion that bypasses Admin integration", () => {
    expect(() => assertTaskTransition("workspace_ready", "merged")).toThrow(
      "Task cannot move from workspace_ready to merged",
    );
  });

  it("allows unfinished tasks to be cancelled but protects submitted work", () => {
    expect(() => assertTaskTransition("active", "cancelled")).not.toThrow();
    expect(() => assertTaskTransition("changes_requested", "cancelled")).not.toThrow();
    expect(() => assertTaskTransition("submitted", "cancelled")).toThrow(
      "Task cannot move from submitted to cancelled",
    );
    expect(() => assertChangeRequestTransition("changes_requested", "cancelled")).not.toThrow();
  });

  it("requires the two change-request approval stages", () => {
    expect(() =>
      assertChangeRequestTransition("submitted", "approved_for_integration"),
    ).not.toThrow();
    expect(() =>
      assertChangeRequestTransition("approved_for_integration", "integrating"),
    ).not.toThrow();
    expect(() =>
      assertChangeRequestTransition("integrating", "awaiting_final_approval"),
    ).not.toThrow();
    expect(() =>
      assertChangeRequestTransition("awaiting_final_approval", "merged"),
    ).not.toThrow();
  });

  it("prevents a submitted change from writing directly to main", () => {
    expect(() => assertChangeRequestTransition("submitted", "merged")).toThrow(
      "Change request cannot move from submitted to merged",
    );
  });
});

describe("Codex event parsing", () => {
  it("captures the provider thread and final agent message", () => {
    const parsed = parseCodexJsonLines(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Implemented and committed the task." },
        }),
      ].join("\n"),
    );

    expect(parsed.providerSessionId).toBe("thread-123");
    expect(parsed.finalMessage).toBe("Implemented and committed the task.");
    expect(parsed.events).toHaveLength(2);
  });
});
