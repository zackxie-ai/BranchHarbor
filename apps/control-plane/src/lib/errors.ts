import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = "BAD_REQUEST",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.statusCode },
    );
  }

  if (error instanceof ZodError) {
    return Response.json(
      {
        error: error.issues[0]?.message ?? "Invalid request",
        code: "VALIDATION_ERROR",
        issues: error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
          code: issue.code,
        })),
      },
      { status: 400 },
    );
  }

  console.error(error);
  return Response.json(
    { error: "CloudAgent encountered an unexpected error", code: "INTERNAL_ERROR" },
    { status: 500 },
  );
}
