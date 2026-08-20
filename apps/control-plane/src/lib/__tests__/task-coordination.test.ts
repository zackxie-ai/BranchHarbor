import { describe, expect, it } from "vitest";

import {
  findFilesOutsideTaskScopes,
  findTaskScopeConflicts,
  isValidTaskScope,
  normalizeTaskScopes,
  taskScopesOverlap,
} from "../task-coordination";

describe("task coordination", () => {
  it("normalizes and removes redundant nested scopes", () => {
    expect(
      normalizeTaskScopes(["./apps/control-plane/**", "apps/control-plane/src", "README.md"]),
    ).toEqual(["README.md", "apps/control-plane"]);
  });

  it("rejects absolute and parent-relative paths", () => {
    expect(isValidTaskScope("/etc/passwd")).toBe(false);
    expect(isValidTaskScope("../shared")).toBe(false);
    expect(isValidTaskScope("apps/control-plane")).toBe(true);
  });

  it("detects prefix overlap without confusing sibling files", () => {
    expect(taskScopesOverlap("apps/control-plane", "apps/control-plane/src")).toBe(true);
    expect(taskScopesOverlap("package.json", "package.json.backup")).toBe(false);
  });

  it("ignores terminal tasks when building soft-lock warnings", () => {
    const conflicts = findTaskScopeConflicts([
      {
        id: "task-a",
        title: "A",
        status: "active",
        expectedChangeScopes: ["apps/control-plane"],
      },
      {
        id: "task-b",
        title: "B",
        status: "draft",
        expectedChangeScopes: ["apps/control-plane/src"],
      },
      {
        id: "task-c",
        title: "C",
        status: "merged",
        expectedChangeScopes: ["apps/control-plane"],
      },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.rightTaskId).toBe("task-b");
  });

  it("finds committed files outside declared scopes", () => {
    expect(
      findFilesOutsideTaskScopes(
        ["apps/control-plane/src/app/page.tsx", "README.md"],
        ["apps/control-plane"],
      ),
    ).toEqual(["README.md"]);
  });
});
