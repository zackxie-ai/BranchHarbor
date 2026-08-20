import { describe, expect, it } from "vitest";

import { detectWorkspaceStructuralConflicts } from "../structural-conflicts";

describe("detectWorkspaceStructuralConflicts", () => {
  it("detects rename collisions and directory moves", () => {
    const conflicts = detectWorkspaceStructuralConflicts({
      taskFiles: [
        { status: "R100", previousPath: "src/legacy/a.ts", path: "src/core/a.ts" },
        { status: "R100", previousPath: "src/legacy/b.ts", path: "src/core/b.ts" },
      ],
      mainFiles: [{ status: "M", path: "src/legacy/config.ts" }],
    });
    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "directory_overlap", severity: "danger" }),
      ]),
    );
  });

  it("detects semantic pairs and import relationships", () => {
    const conflicts = detectWorkspaceStructuralConflicts({
      taskFiles: [{ status: "M", path: "src/users/user.service.ts" }],
      mainFiles: [
        { status: "M", path: "tests/users/user.spec.ts" },
        { status: "M", path: "src/users/model.ts" },
      ],
      taskImports: [
        { importerPath: "src/users/user.service.ts", importedPath: "src/users/model.ts" },
      ],
    });
    expect(conflicts.map((conflict) => conflict.kind)).toContain("semantic_pair");
    expect(conflicts.map((conflict) => conflict.kind)).toContain("import_dependency");
  });

  it("does not turn unrelated top-level files into directory conflicts", () => {
    expect(
      detectWorkspaceStructuralConflicts({
        taskFiles: [{ status: "M", path: "src/a.ts" }],
        mainFiles: [{ status: "M", path: "src/b.ts" }],
      }),
    ).toEqual([]);
  });
});
