import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppError, errorResponse } from "../errors";

describe("errorResponse", () => {
  it("preserves application error status and code", async () => {
    const response = errorResponse(new AppError("Not allowed", 403, "FORBIDDEN"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Not allowed", code: "FORBIDDEN" });
  });

  it("returns structured validation errors as HTTP 400", async () => {
    const schema = z.object({ expectedChangeScopes: z.array(z.string()).min(1) });
    const result = schema.safeParse({ expectedChangeScopes: [] });
    if (result.success) throw new Error("Expected validation to fail");

    const response = errorResponse(result.error);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "VALIDATION_ERROR",
      issues: [
        {
          path: "expectedChangeScopes",
          code: "too_small",
        },
      ],
    });
  });
});
