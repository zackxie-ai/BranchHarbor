import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashPassword } from "../apps/control-plane/src/lib/auth-crypto";
import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import {
  addProjectMembership,
  getTaskRunner,
  insertProject,
  insertTask,
  updateTaskWorkspace,
} from "../apps/control-plane/src/lib/repositories";
import { destroyRunner, launchTaskRunner } from "../apps/control-plane/src/lib/runner";
import { startTaskPreview } from "../apps/control-plane/src/lib/services";

const password = "branchharbor-preview-ui-password";

async function createFixture() {
  const userId = randomUUID();
  const projectId = randomUUID();
  const email = `preview-ui-${userId.slice(0, 8)}@branchharbor.local`;
  const workspacePath = path.join(config.runtimeRoot, "preview-ui", projectId);
  const marker = `BranchHarbor Browser Preview ${projectId.slice(0, 8)}`;

  await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
    userId,
    email,
    "Preview UI Member",
  ]);
  await query(
    "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
    [config.organizationId, userId],
  );
  await query(
    "INSERT INTO user_credentials (user_id, password_hash, must_change_password) VALUES ($1,$2,FALSE)",
    [userId, await hashPassword(password)],
  );
  await mkdir(path.join(workspacePath, "assets"), { recursive: true });
  await writeFile(
    path.join(workspacePath, "index.html"),
    `<!doctype html><html><head><style>body{font-family:system-ui;padding:48px;background:#10161f;color:#eaf1f8}h1{color:#70e1b2}</style></head><body><h1>${marker}</h1><p>Authenticated task preview is running.</p><script src="assets/app.js"></script></body></html>`,
  );
  await writeFile(
    path.join(workspacePath, "assets", "app.js"),
    `document.body.dataset.preview = "ready"; console.log("${marker}");`,
  );
  await insertProject({
    id: projectId,
    name: "Preview UI Fixture",
    slug: `preview-ui-${projectId.slice(0, 8)}`,
    giteaOwner: "fixture",
    giteaRepository: `preview-ui-${projectId.slice(0, 8)}`,
    repositoryUrl: workspacePath,
    localRepositoryPath: workspacePath,
    actorId: userId,
  });
  await addProjectMembership({ projectId, userId, addedBy: userId });
  const task = await insertTask({
    projectId,
    title: "Browser QA for live task preview",
    description: "Temporary fixture for visually validating the BranchHarbor preview UI.",
    acceptanceCriteria: "The embedded application and controls render correctly.",
    verificationCommands: [],
    assignedUserId: userId,
    actorId: userId,
  });
  await updateTaskWorkspace({
    taskId: task.id,
    baseCommit: "preview-ui-base",
    branchName: `task/preview-ui-${task.id.slice(0, 8)}`,
    worktreePath: workspacePath,
  });
  const runner = await launchTaskRunner(task.id, workspacePath);
  const preview = await startTaskPreview(
    task.id,
    { command: "python3 -m http.server $PORT --bind 0.0.0.0", port: 4311 },
    userId,
  );
  console.log(
    JSON.stringify({
      userId,
      email,
      password,
      projectId,
      taskId: task.id,
      runnerId: runner.id,
      previewId: preview.id,
      workspacePath,
      marker,
    }),
  );
}

async function cleanupFixture(projectId: string, userId: string) {
  const [task] = await query<{ id: string; worktree_path: string | null }>(
    "SELECT id, worktree_path FROM tasks WHERE project_id = $1 LIMIT 1",
    [projectId],
  );
  if (task) {
    const runner = await getTaskRunner(task.id).catch(() => null);
    if (runner) {
      await destroyRunner(runner).catch(() => undefined);
    }
  }
  await query("DELETE FROM audit_events WHERE project_id = $1 OR actor_id = $2", [
    projectId,
    userId,
  ]).catch(() => undefined);
  await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
  await query("DELETE FROM users WHERE id = $1", [userId]).catch(() => undefined);
  if (task?.worktree_path) {
    await rm(task.worktree_path, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ projectId, userId, cleaned: true }));
}

async function main() {
  const [command = "create", projectId, userId] = process.argv.slice(2);
  if (command === "cleanup") {
    if (!projectId || !userId) {
      throw new Error("Usage: task-preview-ui-fixture.ts cleanup <projectId> <userId>");
    }
    await cleanupFixture(projectId, userId);
  } else {
    await createFixture();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
