import type { VerificationResult } from "./types";

export type ProjectValidationRunStatus = "queued" | "running" | "passed" | "failed";

export interface ProjectValidationRun {
  id: string;
  projectId: string;
  integrationQueueId: string;
  status: ProjectValidationRunStatus;
  commands: string[];
  results: VerificationResult[];
  mainCommit: string | null;
  worktreePath: string | null;
  errorMessage: string | null;
  createdBy: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}
