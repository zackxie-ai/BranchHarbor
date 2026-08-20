import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AppError } from "../apps/control-plane/src/lib/errors";
import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { cloneRepository, removeTaskWorktree } from "../apps/control-plane/src/lib/git";
import {
  getTaskRunner,
  getTaskWorkspaceBackup as getTaskWorkspaceBackupRecord,
  insertProject,
  insertTask,
} from "../apps/control-plane/src/lib/repositories";
import { destroyRunner } from "../apps/control-plane/src/lib/runner";
import {
  captureTaskWorkspaceProgressForMonitor,
  getTaskWorkspaceBackup,
  getTaskWorkspaceProgress,
  provisionTaskWorkspace,
} from "../apps/control-plane/src/lib/services";

const execFileAsync = promisify(execFile);
const adminId = "00000000-0000-4000-8000-000000000101";
const memberId = randomUUID();
const projectId = randomUUID();
const fixtureRoot = path.join(config.runtimeRoot, "task-workspace-durability-smoke", projectId);
const remotePath = path.join(fixtureRoot, "origin.git");
const seedPath = path.join(fixtureRoot, "seed");
const repositoryPath = path.join(fixtureRoot, "repository");

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function expectAppError(
  action: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AppError && error.code === expectedCode) return;
    throw error;
  }
  throw new Error(`Expected ${expectedCode}`);
}

async function main() {
  let taskId: string | null = null;
  let worktreePath: string | null = null;
  try {
    await mkdir(fixtureRoot, { recursive: true });
    await execFileAsync("git", ["init", "--bare", remotePath]);
    await execFileAsync("git", ["init", "-b", "main", seedPath]);
    await git(seedPath, ["config", "user.name", "Workspace Durability Smoke"]);
    await git(seedPath, ["config", "user.email", "durability@branchharbor.local"]);
    await writeFile(path.join(seedPath, "README.md"), "base\n");
    await git(seedPath, ["add", "README.md"]);
    await git(seedPath, ["commit", "-m", "Base"]);
    await git(seedPath, ["remote", "add", "origin", remotePath]);
    await git(seedPath, ["push", "-u", "origin", "main"]);
    await execFileAsync("git", ["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await cloneRepository(remotePath, repositoryPath);

    await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
      memberId,
      `durability-${memberId.slice(0, 8)}@branchharbor.local`,
      "Durability Unauthorized Member",
    ]);
    await query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
      [config.organizationId, memberId],
    );
    await insertProject({
      id: projectId,
      name: "Task Workspace Durability Smoke",
      slug: `task-workspace-durability-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `task-workspace-durability-${projectId.slice(0, 8)}`,
      repositoryUrl: remotePath,
      localRepositoryPath: repositoryPath,
      actorId: adminId,
    });
    const task = await insertTask({
      projectId,
      title: "Recover cloud task workspace",
      description: "Verify remote branch and WIP checkpoint durability.",
      acceptanceCriteria: "Host storage loss is recoverable from Git.",
      verificationCommands: [],
      expectedChangeScopes: ["README.md", "committed.txt", "draft.txt"],
      assignedUserId: adminId,
      actorId: adminId,
    });
    taskId = task.id;
    await expectAppError(() => getTaskWorkspaceBackup(task.id, memberId), "FORBIDDEN");

    const provisioned = await provisionTaskWorkspace(task.id, adminId);
    worktreePath = provisioned.task.worktreePath;
    if (!worktreePath || !provisioned.task.branchName) {
      throw new Error("Provisioning did not persist task workspace metadata");
    }
    await writeFile(path.join(worktreePath, "committed.txt"), "durable commit\n");
    await git(worktreePath, ["add", "committed.txt"]);
    await git(worktreePath, ["commit", "-m", "Add durable commit"]);
    await writeFile(path.join(worktreePath, "README.md"), "uncommitted tracked change\n");
    await writeFile(path.join(worktreePath, "draft.txt"), "untracked draft\n");

    const progressBeforeFailure = await getTaskWorkspaceProgress(task.id, adminId);
    const backupBeforeFailure = await getTaskWorkspaceBackup(task.id, adminId);
    if (
      !backupBeforeFailure?.checkpointCommit ||
      backupBeforeFailure.remoteHeadCommit !== progressBeforeFailure.headCommit ||
      backupBeforeFailure.changedFiles.length !== 2
    ) {
      throw new Error(`Workspace backup was incomplete: ${JSON.stringify(backupBeforeFailure)}`);
    }
    const remoteBranchHead = (
      await git(fixtureRoot, [
        "--git-dir",
        remotePath,
        "rev-parse",
        `refs/heads/${provisioned.task.branchName}`,
      ])
    ).stdout.trim();
    if (remoteBranchHead !== progressBeforeFailure.headCommit) {
      throw new Error("Remote task branch did not match the local task HEAD");
    }

    await rm(worktreePath, { recursive: true, force: true });
    await rm(repositoryPath, { recursive: true, force: true });
    const monitorResult = await captureTaskWorkspaceProgressForMonitor(task.id);
    if (monitorResult.reason !== "workspace_restored") {
      throw new Error(`Monitor did not report restoration: ${JSON.stringify(monitorResult)}`);
    }
    if ((await readFile(path.join(worktreePath, "committed.txt"), "utf8")) !== "durable commit\n") {
      throw new Error("Committed file was not restored");
    }
    if (
      (await readFile(path.join(worktreePath, "README.md"), "utf8")) !==
        "uncommitted tracked change\n" ||
      (await readFile(path.join(worktreePath, "draft.txt"), "utf8")) !== "untracked draft\n"
    ) {
      throw new Error("WIP checkpoint files were not restored");
    }
    const restoredStatus = (await git(worktreePath, ["status", "--porcelain"])).stdout.trim();
    if (!restoredStatus.includes("M README.md") || !restoredStatus.includes("?? draft.txt")) {
      throw new Error(`Restored files did not remain uncommitted: ${restoredStatus}`);
    }
    const restoredRunner = await getTaskRunner(task.id);
    if (!restoredRunner || restoredRunner.status !== "running") {
      throw new Error(`Runner was not rebuilt: ${JSON.stringify(restoredRunner)}`);
    }
    const restoredBackup = await getTaskWorkspaceBackupRecord(task.id);
    if (!restoredBackup?.lastRestoredAt || restoredBackup.restoredBy !== null) {
      throw new Error(`Restoration metadata was not persisted: ${JSON.stringify(restoredBackup)}`);
    }
    const restoreAudit = await query<{ actor_id: string | null; payload: Record<string, unknown> }>(
      `SELECT actor_id, payload FROM audit_events
        WHERE task_id = $1 AND event_type = 'task.workspace_restored'
        ORDER BY created_at DESC LIMIT 1`,
      [task.id],
    );
    if (restoreAudit.length !== 1 || restoreAudit[0]?.actor_id !== null) {
      throw new Error(`Background restoration audit is incorrect: ${JSON.stringify(restoreAudit)}`);
    }

    await git(worktreePath, ["reset", "--hard", "HEAD"]);
    await git(worktreePath, ["clean", "-fd"]);
    await getTaskWorkspaceProgress(task.id, adminId);
    const cleanBackup = await getTaskWorkspaceBackup(task.id, adminId);
    if (!cleanBackup?.workingTreeClean || cleanBackup.checkpointCommit !== null) {
      throw new Error(`Clean workspace retained a stale checkpoint: ${JSON.stringify(cleanBackup)}`);
    }
    const hiddenRef = (
      await git(fixtureRoot, [
        "--git-dir",
        remotePath,
        "show-ref",
        "--verify",
        `refs/branchharbor/checkpoints/${task.id}`,
      ]).catch(() => ({ stdout: "" }))
    ).stdout.trim();
    if (hiddenRef) throw new Error("Remote WIP checkpoint was not deleted after cleanup");

    console.log(
      JSON.stringify({
        taskId: task.id,
        remoteTaskBranchPersisted: true,
        committedChangesRestored: true,
        trackedAndUntrackedWipRestored: true,
        managerCloneRecreated: true,
        runnerRebuilt: true,
        backgroundAuditRecorded: true,
        unauthorizedMemberDenied: true,
        staleCheckpointDeleted: true,
      }),
    );
  } finally {
    if (taskId) {
      const runner = await getTaskRunner(taskId).catch(() => null);
      if (runner && runner.status !== "destroyed") {
        await destroyRunner(runner).catch(() => undefined);
      }
      if (worktreePath) {
        await removeTaskWorktree({ repositoryPath, worktreePath }).catch(() => undefined);
      }
    }
    await query("DELETE FROM audit_events WHERE project_id = $1 OR task_id = $2", [
      projectId,
      taskId,
    ]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await query("DELETE FROM memberships WHERE user_id = $1", [memberId]).catch(() => undefined);
    await query("DELETE FROM users WHERE id = $1", [memberId]).catch(() => undefined);
    await rm(path.join(config.runtimeRoot, "projects", projectId), { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
