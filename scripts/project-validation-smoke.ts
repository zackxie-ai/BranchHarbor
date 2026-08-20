import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { AppError } from "../apps/control-plane/src/lib/errors";
import {
  addProjectMembership,
  getProjectValidationRun,
  getProjectValidationRunner,
  insertChangeRequest,
  insertProject,
  insertTask,
  refreshProjectIntegrationQueueStatus,
} from "../apps/control-plane/src/lib/repositories";
import {
  getProjectValidationHistory,
  queueProjectValidationRun,
  replaceProjectIntegrationQueue,
} from "../apps/control-plane/src/lib/services";
import { durableRunProjectValidation } from "../apps/control-plane/src/temporal/client";

const execFileAsync = promisify(execFile);
const adminId = "00000000-0000-4000-8000-000000000101";
const memberId = randomUUID();
const projectId = randomUUID();
const projectRoot = path.join(config.runtimeRoot, "projects", projectId);
const originPath = path.join(projectRoot, "origin.git");
const seedPath = path.join(projectRoot, "seed");
const repositoryPath = path.join(projectRoot, "repository");

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function expectAppError(action: () => Promise<unknown>, expectedCode: string) {
  try {
    await action();
  } catch (error) {
    if (error instanceof AppError && error.code === expectedCode) return;
    throw error;
  }
  throw new Error(`Expected ${expectedCode}`);
}

async function waitForTerminalRun(runId: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const run = await getProjectValidationRun(runId);
    if (["passed", "failed"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Project validation ${runId} did not finish`);
}

async function createMergedQueue(input: {
  baseCommit: string;
  alphaCommit: string;
  betaCommit: string;
}) {
  const alphaTask = await insertTask({
    projectId,
    title: "Alpha merged change",
    description: "First merged change for joint validation",
    acceptanceCriteria: "alpha.txt exists",
    verificationCommands: ["test -f alpha.txt"],
    expectedChangeScopes: ["alpha.txt"],
    assignedUserId: adminId,
    actorId: adminId,
  });
  const alphaRequest = await insertChangeRequest({
    taskId: alphaTask.id,
    summary: "Add alpha.txt for joint validation.",
    baseCommit: input.baseCommit,
    headCommit: input.alphaCommit,
    changedFiles: [{ status: "A", path: "alpha.txt" }],
    diffStat: "1 file changed",
    verificationResults: [],
    risks: [],
    actorId: adminId,
  });
  const betaTask = await insertTask({
    projectId,
    title: "Beta merged change",
    description: "Second merged change for joint validation",
    acceptanceCriteria: "beta.txt contains beta",
    verificationCommands: ["grep -q '^beta$' beta.txt"],
    expectedChangeScopes: ["beta.txt"],
    assignedUserId: adminId,
    actorId: adminId,
  });
  const betaRequest = await insertChangeRequest({
    taskId: betaTask.id,
    summary: "Add beta.txt for joint validation.",
    baseCommit: input.alphaCommit,
    headCommit: input.betaCommit,
    changedFiles: [{ status: "A", path: "beta.txt" }],
    diffStat: "1 file changed",
    verificationResults: [],
    risks: [],
    actorId: adminId,
  });
  const queue = await replaceProjectIntegrationQueue(projectId, {
    source: "deterministic",
    selectedTaskIds: [betaTask.id, alphaTask.id],
  }, adminId);
  await query(
    "UPDATE tasks SET status = 'merged', updated_at = NOW() WHERE id = ANY($1::UUID[])",
    [[alphaTask.id, betaTask.id]],
  );
  await query(
    "UPDATE change_requests SET status = 'merged', updated_at = NOW() WHERE id = ANY($1::UUID[])",
    [[alphaRequest.id, betaRequest.id]],
  );
  const completed = await refreshProjectIntegrationQueueStatus(projectId);
  if (completed?.status !== "completed") throw new Error("Integration Queue did not complete");
  return completed;
}

async function main() {
  try {
    await mkdir(projectRoot, { recursive: true });
    await execFileAsync("git", ["init", "--bare", originPath]);
    await execFileAsync("git", ["init", seedPath]);
    await git(seedPath, ["config", "user.name", "BranchHarbor Validation Smoke"]);
    await git(seedPath, ["config", "user.email", "validation-smoke@branchharbor.local"]);
    await git(seedPath, ["checkout", "-b", "main"]);
    await writeFile(path.join(seedPath, "README.md"), "validation smoke\n");
    await git(seedPath, ["add", "README.md"]);
    await git(seedPath, ["commit", "-m", "Base"]);
    const baseCommit = (await git(seedPath, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(seedPath, "alpha.txt"), "alpha\n");
    await git(seedPath, ["add", "alpha.txt"]);
    await git(seedPath, ["commit", "-m", "Add alpha"]);
    const alphaCommit = (await git(seedPath, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(seedPath, "beta.txt"), "beta\n");
    await git(seedPath, ["add", "beta.txt"]);
    await git(seedPath, ["commit", "-m", "Add beta"]);
    const betaCommit = (await git(seedPath, ["rev-parse", "HEAD"])).stdout.trim();
    await git(seedPath, ["remote", "add", "origin", originPath]);
    await git(seedPath, ["push", "-u", "origin", "main"]);
    await execFileAsync("git", ["--git-dir", originPath, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await execFileAsync("git", ["clone", originPath, repositoryPath]);

    await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
      memberId,
      `project-validation-${memberId.slice(0, 8)}@branchharbor.local`,
      "Project Validation Member",
    ]);
    await query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
      [config.organizationId, memberId],
    );
    await insertProject({
      id: projectId,
      name: "Project Validation Smoke",
      slug: `project-validation-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `project-validation-${projectId.slice(0, 8)}`,
      repositoryUrl: originPath,
      localRepositoryPath: repositoryPath,
      actorId: adminId,
    });
    await addProjectMembership({ projectId, userId: memberId, addedBy: adminId });
    const queue = await createMergedQueue({ baseCommit, alphaCommit, betaCommit });

    await expectAppError(
      () => queueProjectValidationRun(projectId, {
        integrationQueueId: queue.id,
        commands: ["git rev-parse --verify HEAD"],
      }, memberId),
      "ADMIN_REQUIRED",
    );
    const passingRun = await queueProjectValidationRun(projectId, {
      integrationQueueId: queue.id,
      commands: ["git rev-parse --verify HEAD"],
    }, adminId);
    if (passingRun.commands.length !== 3) {
      throw new Error(`Expected aggregated commands, got ${JSON.stringify(passingRun.commands)}`);
    }
    await expectAppError(
      () => queueProjectValidationRun(projectId, {
        integrationQueueId: queue.id,
        commands: ["true"],
      }, adminId),
      "PROJECT_VALIDATION_ALREADY_RUNNING",
    );
    await durableRunProjectValidation({ runId: passingRun.id, actorId: adminId });
    const passed = await waitForTerminalRun(passingRun.id);
    if (passed.status !== "passed" || passed.mainCommit !== betaCommit || passed.results.length !== 3) {
      throw new Error(`Joint validation did not pass with complete evidence: ${JSON.stringify(passed)}`);
    }
    const passingRunner = await getProjectValidationRunner(passingRun.id);
    if (passingRunner?.status !== "destroyed") {
      throw new Error(`Validation Runner was not destroyed: ${passingRunner?.status}`);
    }
    try {
      await access(path.join(projectRoot, "validations", passingRun.id));
      throw new Error("Validation Worktree was not removed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const failingRun = await queueProjectValidationRun(projectId, {
      integrationQueueId: queue.id,
      commands: ["printf 'joint failure\\n'; exit 7"],
    }, adminId);
    await durableRunProjectValidation({ runId: failingRun.id, actorId: adminId });
    const failed = await waitForTerminalRun(failingRun.id);
    if (failed.status !== "failed" || failed.results.at(-1)?.exitCode !== 7) {
      throw new Error(`Failing validation evidence was not persisted: ${JSON.stringify(failed)}`);
    }

    const memberHistory = await getProjectValidationHistory(projectId, memberId);
    if (memberHistory.length !== 2) throw new Error("Project member cannot read validation history");
    const auditRows = await query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE project_id = $1 AND event_type LIKE 'project.validation_%'`,
      [projectId],
    );
    if (!auditRows.some((row) => row.event_type === "project.validation_passed") ||
        !auditRows.some((row) => row.event_type === "project.validation_failed")) {
      throw new Error(`Validation audit events are incomplete: ${JSON.stringify(auditRows)}`);
    }

    console.log(JSON.stringify({
      queueId: queue.id,
      passingRunId: passed.id,
      passingMainCommit: passed.mainCommit,
      passingCommands: passed.results.length,
      failingRunId: failed.id,
      failingExitCode: failed.results.at(-1)?.exitCode,
      memberHistoryVisible: true,
      runnerDestroyed: true,
    }));
  } finally {
    await query("DELETE FROM audit_events WHERE project_id = $1 OR actor_id = $2", [
      projectId,
      memberId,
    ]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await query("DELETE FROM users WHERE id = $1", [memberId]).catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
