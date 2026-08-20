import { z } from "zod";

import {
  isValidTaskScope,
  normalizeTaskScopes,
} from "./task-coordination";

export const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.preprocess(
    (value) => {
      if (value == null) return undefined;
      if (typeof value !== "string") return value;
      const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return normalized || undefined;
    },
    z
      .string()
      .min(2)
      .max(50)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
  ),
});

export const createTaskSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(5_000).default(""),
  acceptanceCriteria: z.string().trim().max(5_000).default(""),
  assignedUserId: z.string().uuid(),
  agentConnectionId: z.string().uuid().nullable().optional(),
  verificationCommands: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  expectedChangeScopes: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(300)
        .refine(isValidTaskScope, "Use a repository-relative file or directory path"),
    )
    .min(1, "Declare at least one expected file or directory path")
    .max(30)
    .transform(normalizeTaskScopes),
  dependsOnTaskIds: z.array(z.string().uuid()).max(20).default([]),
});

export const projectMemberSchema = z.object({
  userId: z.string().uuid(),
});

export const updateTaskDependenciesSchema = z.object({
  dependsOnTaskIds: z.array(z.string().uuid()).max(20).default([]),
});

export const recoverTaskDependencySchema = z
  .object({
    failedDependencyTaskId: z.string().uuid(),
    replacementTaskId: z.string().uuid().nullable().default(null),
    reason: z.string().trim().min(10).max(1_000),
  })
  .refine(
    (input) => input.failedDependencyTaskId !== input.replacementTaskId,
    {
      path: ["replacementTaskId"],
      message: "The failed dependency cannot replace itself",
    },
  );

export const markProjectNotificationsReadSchema = z.object({
  notificationIds: z.array(z.string().uuid()).max(100).default([]),
});

export const submitChangeRequestSchema = z.object({
  summary: z.string().trim().min(10).max(10_000),
  risks: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
});

export const reviewSchema = z.object({
  decision: z.enum(["request_changes", "reject", "approve_integration", "approve_final"]),
  comment: z.string().trim().max(5_000).default(""),
});

export const configureAgentCredentialSchema = z.object({
  apiKey: z.string().trim().min(20).max(1_000),
  model: z.string().trim().min(1).max(100).optional(),
});

export const createAgentConnectionSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  provider: z.string().trim().min(2).max(50).regex(/^[a-z0-9-]+$/),
  protocol: z.enum(["local", "acp", "openai-compatible"]),
  model: z.string().trim().min(1).max(100).optional(),
  apiBaseUrl: z.url().max(500).optional(),
  maxToolRounds: z.coerce.number().int().min(1).max(100).default(24),
  launcherCommand: z.preprocess(
    (value) => value ?? "",
    z.string().trim().max(300),
  ),
  launcherArguments: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  credentialEnvironmentVariable: z
    .string()
    .trim()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .max(100),
  apiKey: z.string().trim().min(20).max(2_000),
}).superRefine((connection, context) => {
  if (connection.provider === "codex" && connection.protocol !== "local") {
    context.addIssue({
      code: "custom",
      path: ["protocol"],
      message: "Codex currently uses the BranchHarbor local JSONL adapter, not ACP",
    });
  }
  if (connection.protocol === "openai-compatible") {
    if (!connection.apiBaseUrl) {
      context.addIssue({
        code: "custom",
        path: ["apiBaseUrl"],
        message: "OpenAI-compatible connections require an API Base URL",
      });
    }
    if (!connection.model) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "OpenAI-compatible connections require a model",
      });
    }
    if (connection.apiBaseUrl) {
      let apiUrl: URL | null = null;
      try {
        apiUrl = new URL(connection.apiBaseUrl);
      } catch {
        // The field-level URL validator reports the malformed URL.
      }
      if (apiUrl && (
        !["http:", "https:"].includes(apiUrl.protocol) ||
        apiUrl.username ||
        apiUrl.password ||
        apiUrl.search ||
        apiUrl.hash
      )) {
        context.addIssue({
          code: "custom",
          path: ["apiBaseUrl"],
          message: "API Base URL must be HTTP(S) without credentials, query parameters, or fragments",
        });
      }
    }
  } else if (!connection.launcherCommand) {
    context.addIssue({
      code: "custom",
      path: ["launcherCommand"],
      message: "Runner-based Agent connections require a launcher command",
    });
  }
});

export const agentPromptSchema = z.object({
  prompt: z.string().trim().min(10).max(20_000),
  resumeSessionId: z.string().uuid().optional(),
});

export const resolveAgentPermissionSchema = z.object({
  selectedOptionId: z.string().trim().min(1).max(200).nullable(),
});

export const integrationAgentPromptSchema = z.object({
  agentConnectionId: z.string().uuid(),
  prompt: z.string().trim().min(10).max(20_000),
  resumeSessionId: z.string().uuid().optional(),
});

export const projectMergePlanAgentSchema = z.object({
  agentConnectionId: z.string().uuid(),
  instruction: z.string().trim().min(10).max(10_000),
});

export const projectIntegrationQueueSchema = z.object({
  source: z.enum(["deterministic", "semantic"]),
  selectedTaskIds: z.array(z.string().uuid()).min(1).max(100),
});

export const cancelProjectIntegrationQueueSchema = z.object({
  reason: z.string().trim().min(10).max(1_000),
});

export const projectValidationRunSchema = z.object({
  integrationQueueId: z.string().uuid(),
  commands: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
});

export const createMembershipInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().min(2).max(100),
  role: z.enum(["admin", "member"]).default("member"),
  expiresInHours: z.coerce.number().int().min(1).max(168).default(72),
});

export const acceptMembershipInvitationSchema = z
  .object({
    token: z.string().trim().min(32).max(200),
    password: z.string().min(12).max(200),
    passwordConfirmation: z.string().min(12).max(200),
  })
  .refine((input) => input.password === input.passwordConfirmation, {
    path: ["passwordConfirmation"],
    message: "The password confirmation does not match",
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(12).max(200),
    passwordConfirmation: z.string().min(12).max(200),
  })
  .refine((input) => input.newPassword === input.passwordConfirmation, {
    path: ["passwordConfirmation"],
    message: "The new password confirmation does not match",
  })
  .refine((input) => input.currentPassword !== input.newPassword, {
    path: ["newPassword"],
    message: "The new password must differ from the current password",
  });

export const startTaskPreviewSchema = z.object({
  command: z.string().trim().min(2).max(2_000),
  port: z.coerce.number().int().min(1024).max(65_535),
});
