import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { AppError } from "../apps/control-plane/src/lib/errors";
import { deleteSecret, readSecret } from "../apps/control-plane/src/lib/openbao";
import {
  addProjectMembership,
  getTask,
  getTaskRunner,
  insertProject,
  insertTask,
  listTaskPreviewRuns,
} from "../apps/control-plane/src/lib/repositories";
import { destroyRunner } from "../apps/control-plane/src/lib/runner";
import {
  cancelTask,
  provisionTaskWorkspace,
  startTaskPreview,
} from "../apps/control-plane/src/lib/services";
import { durableCancelTask } from "../apps/control-plane/src/temporal/client";

const execFileAsync = promisify(execFile);
const adminId = "00000000-0000-4000-8000-000000000101";
const unrelatedMemberId = "00000000-0000-4000-8000-000000000102";
const operatorId = randomUUID();
const projectId = randomUUID();
const fixtureRoot = path.join(config.runtimeRoot, "task-cancellation-smoke", projectId);
const originPath = path.join(fixtureRoot, "origin.git");
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
    if (error instanceof AppError && error.code === expectedCode) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected ${expectedCode}`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let taskId: string | null = null;
  let runnerCredentialRef: string | null = null;
  let workspacePath: string | null = null;
  try {
    await mkdir(fixtureRoot, { recursive: true });
    await execFileAsync("git", ["init", "--bare", originPath]);
    await execFileAsync("git", ["init", "-b", "main", seedPath]);
    await git(seedPath, ["config", "user.name", "Task Cancellation Smoke"]);
    await git(seedPath, ["config", "user.email", "cancellation@branchharbor.local"]);
    await writeFile(path.join(seedPath, "README.md"), "BranchHarbor cancellation smoke\n");
    await git(seedPath, ["add", "README.md"]);
    await git(seedPath, ["commit", "-m", "Base"]);
    await git(seedPath, ["remote", "add", "origin", originPath]);
    await git(seedPath, ["push", "-u", "origin", "main"]);
    await execFileAsync("git", ["--git-dir", originPath, "symbolic-ref", "HEAD", "refs/heads/main"]);

    await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
      operatorId,
      `task-cancel-${operatorId.slice(0, 8)}@branchharbor.local`,
      "Task Cancellation Operator",
    ]);
    await query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
      [config.organizationId, operatorId],
    );
    await insertProject({
      id: projectId,
      name: "Task Cancellation Smoke",
      slug: `task-cancel-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `task-cancel-${projectId.slice(0, 8)}`,
      repositoryUrl: originPath,
      localRepositoryPath: repositoryPath,
      actorId: adminId,
    });
    await addProjectMembership({ projectId, userId: operatorId, addedBy: adminId });
    const task = await insertTask({
      projectId,
      title: "Cancel task and release resources",
      description: "Exercise the complete cancellation cleanup path.",
      acceptanceCriteria: "Runner, preview, Agent work, and Worktree are released.",
      verificationCommands: [],
      assignedUserId: operatorId,
      actorId: adminId,
    });
    taskId = task.id;
    const provisioned = await provisionTaskWorkspace(task.id, operatorId);
    workspacePath = provisioned.task.worktreePath;
    if (!workspacePath) {
      throw new Error("Task workspace was not provisioned");
    }
    const runner = provisioned.runner;
    runnerCredentialRef = runner.credentialRef;
    const preview = await startTaskPreview(
      task.id,
      { command: "python3 -m http.server $PORT --bind 0.0.0.0", port: 4312 },
      operatorId,
    );
    const sessionId = randomUUID();
    const permissionId = randomUUID();
    const changeRequestId = randomUUID();
    await query(
      `INSERT INTO agent_sessions (id, task_id, runner_id, status, prompt)
       VALUES ($1,$2,$3,'running',$4)`,
      [sessionId, task.id, runner.id, "Keep working until the task is cancelled."],
    );
    await query(
      `INSERT INTO agent_permission_requests (
         id, session_id, provider_request_id, tool_call, options
       ) VALUES ($1,$2,$3,$4::JSONB,$5::JSONB)`,
      [
        permissionId,
        sessionId,
        `cancel-smoke-${permissionId}`,
        JSON.stringify({ title: "Run command" }),
        JSON.stringify([{ optionId: "allow", name: "Allow" }]),
      ],
    );
    await query(
      `INSERT INTO change_requests (
         id, task_id, status, summary, base_commit, head_commit,
         changed_files, diff_stat, verification_results, risks, created_by
       ) VALUES ($1,$2,'changes_requested',$3,$4,$5,'[]'::JSONB,'','[]'::JSONB,'[]'::JSONB,$6)`,
      [
        changeRequestId,
        task.id,
        "Temporary change request used to verify task cancellation.",
        "cancel-smoke-base",
        "cancel-smoke-head",
        operatorId,
      ],
    );
    await query("UPDATE tasks SET status = 'changes_requested' WHERE id = $1", [task.id]);

    await expectAppError(() => cancelTask(task.id, unrelatedMemberId), "FORBIDDEN");
    const result = await durableCancelTask({ taskId: task.id, actorId: operatorId });
    const repeated = await durableCancelTask({ taskId: task.id, actorId: operatorId });
    const cancelledTask = await getTask(task.id);
    const cancelledRunner = await getTaskRunner(task.id);
    const previews = await listTaskPreviewRuns(task.id);
    const [session] = await query<{
      cancel_requested_at: Date | null;
      cancelled_by: string | null;
    }>("SELECT cancel_requested_at, cancelled_by FROM agent_sessions WHERE id = $1", [sessionId]);
    const [permission] = await query<{ status: string; resolved_by: string | null }>(
      "SELECT status, resolved_by FROM agent_permission_requests WHERE id = $1",
      [permissionId],
    );
    const [changeRequest] = await query<{ status: string }>(
      "SELECT status FROM change_requests WHERE id = $1",
      [changeRequestId],
    );
    const [audit] = await query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM audit_events WHERE task_id = $1 AND event_type = 'task.cancelled'",
      [task.id],
    );
    let runnerCredentialDeleted = false;
    try {
      await readSecret(runner.credentialRef);
    } catch {
      runnerCredentialDeleted = true;
    }

    if (result.status !== "cancelled" || repeated.status !== "cancelled") {
      throw new Error("Task cancellation was not idempotent");
    }
    if (cancelledTask.status !== "cancelled" || cancelledTask.worktreePath !== null) {
      throw new Error("Task state or Worktree reference was not cleared");
    }
    if (cancelledRunner?.status !== "destroyed") {
      throw new Error("Task Runner was not destroyed");
    }
    if (previews[0]?.id !== preview.id || previews[0].status !== "stopped") {
      throw new Error("Active task preview was not stopped");
    }
    if (!session?.cancel_requested_at || session.cancelled_by !== operatorId) {
      throw new Error("Active Agent session did not receive a cancellation request");
    }
    if (permission?.status !== "cancelled" || permission.resolved_by !== operatorId) {
      throw new Error("Pending Agent permission was not cancelled");
    }
    if (changeRequest?.status !== "cancelled") {
      throw new Error("Changes-requested submission was not cancelled with the task");
    }
    if (await pathExists(workspacePath)) {
      throw new Error("Task Worktree directory still exists");
    }
    if (audit?.count !== "1") {
      throw new Error(`Expected one cancellation audit event, received ${audit?.count ?? "0"}`);
    }
    if (!runnerCredentialDeleted) {
      throw new Error("Runner credential still exists in OpenBao");
    }

    console.log(
      JSON.stringify({
        taskId: task.id,
        runnerId: runner.id,
        previewId: preview.id,
        unauthorizedCancellationRejected: true,
        taskCancelled: true,
        cancellationIdempotent: true,
        agentCancellationRequested: true,
        pendingPermissionCancelled: true,
        changeRequestCancelled: true,
        previewStopped: true,
        runnerDestroyed: true,
        runnerCredentialDeleted: true,
        worktreeRemoved: true,
        auditRecordedOnce: true,
      }),
    );
  } finally {
    if (taskId) {
      const runner = await getTaskRunner(taskId).catch(() => null);
      if (runner && runner.status !== "destroyed") {
        await destroyRunner(runner).catch(() => undefined);
      }
    }
    if (runnerCredentialRef) {
      await deleteSecret(runnerCredentialRef).catch(() => undefined);
    }
    await query("DELETE FROM audit_events WHERE project_id = $1 OR actor_id = $2", [
      projectId,
      operatorId,
    ]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await query("DELETE FROM workflow_executions WHERE started_by = $1", [operatorId]).catch(
      () => undefined,
    );
    await query("DELETE FROM users WHERE id = $1", [operatorId]).catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
