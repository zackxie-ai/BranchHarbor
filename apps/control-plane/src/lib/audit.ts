import { z } from "zod";

import { AppError } from "./errors";

const optionalUuid = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.string().uuid().optional(),
);

const optionalText = (maximum: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(maximum).optional(),
  );

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, "Invalid calendar date");

export const auditQuerySchema = z
  .object({
    actorId: optionalUuid,
    projectId: optionalUuid,
    taskId: optionalUuid,
    eventType: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().trim().max(160).regex(/^[a-z0-9_.:-]+$/i).optional(),
    ),
    search: optionalText(200),
    from: z.preprocess(
      (value) => (value === "" || value === null ? undefined : value),
      dateString.optional(),
    ),
    to: z.preprocess(
      (value) => (value === "" || value === null ? undefined : value),
      dateString.optional(),
    ),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .refine((value) => [25, 50, 100].includes(value), "Unsupported page size")
      .default(25),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    path: ["to"],
    message: "The end date must not be before the start date",
  });

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditEvent {
  id: string;
  organizationId: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditEventPage {
  events: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export function parseAuditQuery(input: unknown): AuditQuery {
  const result = auditQuerySchema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      result.error.issues[0]?.message ?? "Invalid audit query",
      400,
      "INVALID_AUDIT_QUERY",
    );
  }
  return result.data;
}
