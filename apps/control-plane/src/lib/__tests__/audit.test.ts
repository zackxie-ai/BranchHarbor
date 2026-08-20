import { describe, expect, it } from "vitest";

import { parseAuditQuery } from "../audit";
import { AppError } from "../errors";

describe("audit query", () => {
  it("applies bounded pagination defaults", () => {
    expect(parseAuditQuery({})).toMatchObject({ page: 1, pageSize: 25 });
    expect(parseAuditQuery({ page: "3", pageSize: "100" })).toMatchObject({
      page: 3,
      pageSize: 100,
    });
  });

  it("normalizes empty optional filters", () => {
    expect(
      parseAuditQuery({ actorId: "", projectId: "", eventType: "", search: " " }),
    ).toEqual({ page: 1, pageSize: 25 });
  });

  it("rejects malformed filters and reversed dates", () => {
    for (const input of [
      { actorId: "not-a-uuid" },
      { pageSize: "10" },
      { from: "2026-02-30" },
      { from: "2026-08-20", to: "2026-08-19" },
    ]) {
      expect(() => parseAuditQuery(input)).toThrowError(AppError);
      try {
        parseAuditQuery(input);
      } catch (error) {
        expect((error as AppError).code).toBe("INVALID_AUDIT_QUERY");
      }
    }
  });
});
