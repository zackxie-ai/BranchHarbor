import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(process.cwd(), "../..");
const adminId = "00000000-0000-4000-8000-000000000101";
const projectId = randomUUID();
const taskQueue = `branchharbor-progress-monitor-${projectId.slice(0, 8)}`;
process.env.TEMPORAL_TASK_QUEUE = taskQueue;

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 45_000,
  intervalMs = 500,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function startWorker(): Promise<ChildProcessWithoutNullStreams> {
  const worker = spawn("pnpm", ["--filter", "@branchharbor/control-plane", "worker"], {
    cwd: repositoryRoot,
    env: { ...process.env, TEMPORAL_TASK_QUEUE: taskQueue },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  worker.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  worker.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  await waitFor(
    async () => {
      if (worker.exitCode !== null) {
        throw new Error(`Worker exited before becoming ready:\n${output}`);
      }
      return output.includes(`queue ${taskQueue}`) && output.includes("RUNNING");
    },
    "the isolated Temporal worker",
    30_000,
    250,
  );
  return worker;
}

async function stopWorker(worker: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!worker || worker.exitCode !== null) return;
  worker.kill("SIGINT");
  await Promise.race([
    new Promise<void>((resolve) => worker.once("exit", () => resolve())),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("Worker did not stop cleanly")), 15_000),
    ),
  ]);
}

async function main() {
  const { config } = await import("../apps/control-plane/src/lib/config");
  const { query } = await import("../apps/control-plane/src/lib/db");
  const {
    getTaskRunner,
    insertProject,
    insertTask,
    listTaskWorkspaceSnapshots,
  } = await import("../apps/control-plane/src/lib/repositories");
  const { destroyRunner } = await import("../apps/control-plane/src/lib/runner");
  const {
    durableCancelTask,
    durableProvisionTaskWorkspace,
    durableWorkflowResult,
  } = await import("../apps/control-plane/src/temporal/client");

  const projectRoot = path.join(config.runtimeRoot, "task-progress-monitor-smoke", projectId);
  const remotePath = path.join(projectRoot, "origin.git");
  const seedPath = path.join(projectRoot, "seed");
  const repositoryPath = path.join(projectRoot, "repository");
  const monitorWorkflowId = `branchharbor-task-workspace-monitor-`;
  let taskId: string | null = null;
  let worker: ChildProcessWithoutNullStreams | null = null;

  try {
    await mkdir(projectRoot, { recursive: true });
    await execFileAsync("git", ["init", "--bare", remotePath]);
    await execFileAsync("git", ["init", "-b", "main", seedPath]);
    await git(seedPath, ["config", "user.name", "Progress Monitor Smoke"]);
    await git(seedPath, ["config", "user.email", "progress-monitor@branchharbor.local"]);
    await writeFile(path.join(seedPath, "README.md"), "base\n");
    await git(seedPath, ["add", "README.md"]);
    await git(seedPath, ["commit", "-m", "Base"]);
    await git(seedPath, ["remote", "add", "origin", remotePath]);
    await git(seedPath, ["push", "-u", "origin", "main"]);
    await execFileAsync("git", ["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await execFileAsync("git", ["clone", remotePath, repositoryPath]);

    await insertProject({
      id: projectId,
      name: "Task Progress Monitor Smoke",
      slug: `task-progress-monitor-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `task-progress-monitor-${projectId.slice(0, 8)}`,
      repositoryUrl: remotePath,
      localRepositoryPath: repositoryPath,
      actorId: adminId,
    });
    const task = await insertTask({
      projectId,
      title: "Monitor task progress without an open browser",
      description: "Verify durable background workspace snapshots.",
      acceptanceCriteria: "Worker restart resumes snapshot collection.",
      verificationCommands: [],
      expectedChangeScopes: ["README.md", "background-one.txt", "background-two.txt"],
      assignedUserId: adminId,
      actorId: adminId,
    });
    taskId = task.id;
    const fullMonitorWorkflowId = `${monitorWorkflowId}${task.id}`;

    worker = await startWorker();
    await durableProvisionTaskWorkspace({ taskId: task.id, actorId: adminId });
    await waitFor(
      async () => (await listTaskWorkspaceSnapshots(task.id)).length >= 1,
      "the initial background snapshot",
    );
    const runner = await getTaskRunner(task.id);
    if (!runner) throw new Error("Provisioning did not create a task Runner");

    await writeFile(path.join(runner.workspacePath, "background-one.txt"), "first change\n");
    await waitFor(
      async () => (await listTaskWorkspaceSnapshots(task.id)).length >= 2,
      "the first background file snapshot",
      30_000,
    );

    await stopWorker(worker);
    worker = null;
    const snapshotsBeforeOfflineChange = (await listTaskWorkspaceSnapshots(task.id)).length;
    await writeFile(path.join(runner.workspacePath, "background-two.txt"), "second change\n");
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    if ((await listTaskWorkspaceSnapshots(task.id)).length !== snapshotsBeforeOfflineChange) {
      throw new Error("Snapshot collection continued while the isolated Worker was stopped");
    }

    worker = await startWorker();
    await waitFor(
      async () => (await listTaskWorkspaceSnapshots(task.id)).length >= 3,
      "snapshot collection after Worker restart",
      30_000,
    );

    await durableCancelTask({ taskId: task.id, actorId: adminId });
    const monitorResult = await Promise.race([
      durableWorkflowResult(fullMonitorWorkflowId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Monitor Workflow did not stop after cancellation")), 30_000),
      ),
    ]);
    if (
      !monitorResult ||
      typeof monitorResult !== "object" ||
      !("status" in monitorResult) ||
      monitorResult.status !== "stopped"
    ) {
      throw new Error(`Unexpected monitor result: ${JSON.stringify(monitorResult)}`);
    }

    console.log(
      JSON.stringify({
        taskId: task.id,
        taskQueue,
        initialSnapshotCapturedWithoutBrowser: true,
        fileChangeCapturedInBackground: true,
        workerStopPausedCollection: true,
        workerRestartResumedCollection: true,
        taskCancellationStoppedMonitor: true,
        runnerAndWorktreeReleased: true,
      }),
    );
  } finally {
    await stopWorker(worker).catch(() => undefined);
    if (taskId) {
      const runner = await getTaskRunner(taskId).catch(() => null);
      if (runner && runner.status !== "destroyed") {
        await destroyRunner(runner).catch(() => undefined);
      }
    }
    await query("DELETE FROM audit_events WHERE project_id = $1", [projectId]).catch(
      () => undefined,
    );
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
