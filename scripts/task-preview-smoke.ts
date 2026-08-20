import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { config } from "../apps/control-plane/src/lib/config";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
} from "../apps/control-plane/src/lib/auth-crypto";
import { query } from "../apps/control-plane/src/lib/db";
import { AppError } from "../apps/control-plane/src/lib/errors";
import {
  addProjectMembership,
  getTaskRunner,
  insertAuthSession,
  insertProject,
  insertTask,
  listTaskPreviewRuns,
  updateTaskWorkspace,
} from "../apps/control-plane/src/lib/repositories";
import { destroyRunner, launchTaskRunner } from "../apps/control-plane/src/lib/runner";
import {
  refreshTaskPreview,
  startTaskPreview,
  stopTaskPreview,
} from "../apps/control-plane/src/lib/services";

const adminId = "00000000-0000-4000-8000-000000000101";
const memberId = "00000000-0000-4000-8000-000000000102";
const operatorId = randomUUID();
const operatorEmail = `task-preview-operator-${operatorId.slice(0, 8)}@cloudagent.local`;
const projectId = randomUUID();
const workspacePath = path.join(config.runtimeRoot, "preview-smoke", projectId);
const marker = `CloudAgent Preview ${projectId.slice(0, 8)}`;
const browserToken = createSessionToken();

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

async function main() {
  let taskId: string | null = null;
  try {
    await query(
      "INSERT INTO users (id, email, name) VALUES ($1,$2,$3)",
      [operatorId, operatorEmail, "Task Preview Smoke Operator"],
    );
    await query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
      [config.organizationId, operatorId],
    );
    await query(
      "INSERT INTO user_credentials (user_id, password_hash, must_change_password) VALUES ($1,$2,FALSE)",
      [operatorId, await hashPassword("task-preview-smoke-password")],
    );
    await mkdir(workspacePath, { recursive: true });
    await mkdir(path.join(workspacePath, "assets"), { recursive: true });
    await writeFile(
      path.join(workspacePath, "index.html"),
      `<!doctype html><html><body><h1>${marker}</h1><script src="assets/app.js"></script></body></html>`,
    );
    await writeFile(path.join(workspacePath, "assets", "app.js"), `window.previewMarker = "${marker}";`);
    await insertProject({
      id: projectId,
      name: "Task Preview Smoke",
      slug: `task-preview-smoke-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `task-preview-smoke-${projectId.slice(0, 8)}`,
      repositoryUrl: workspacePath,
      localRepositoryPath: workspacePath,
      actorId: adminId,
    });
    await addProjectMembership({ projectId, userId: operatorId, addedBy: adminId });
    await addProjectMembership({ projectId, userId: memberId, addedBy: adminId });
    const task = await insertTask({
      projectId,
      title: "Serve an isolated task preview",
      description: "Exercise the real AIO Sandbox preview lifecycle.",
      acceptanceCriteria: "The preview must be accessible and stoppable.",
      verificationCommands: [],
      assignedUserId: operatorId,
      actorId: adminId,
    });
    taskId = task.id;
    await updateTaskWorkspace({
      taskId: task.id,
      baseCommit: "preview-smoke-base",
      branchName: `task/preview-smoke-${task.id.slice(0, 8)}`,
      worktreePath: workspacePath,
    });
    const runner = await launchTaskRunner(task.id, workspacePath);
    await insertAuthSession({
      userId: operatorId,
      tokenHash: hashSessionToken(browserToken),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const previewInput = {
      command: "python3 -m http.server $PORT --bind 0.0.0.0",
      port: 4310,
    };
    await expectAppError(
      () => startTaskPreview(task.id, previewInput, memberId),
      "FORBIDDEN",
    );
    const preview = await startTaskPreview(task.id, previewInput, operatorId);
    if (preview.status !== "running") {
      throw new Error(`Preview did not start: ${preview.status}`);
    }
    const controlPlaneUrl = `http://127.0.0.1:${process.env.CONTROL_PLANE_PORT ?? "3210"}`;
    const unauthenticatedResponse = await fetch(`${controlPlaneUrl}${preview.previewUrl}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (unauthenticatedResponse.status !== 401) {
      throw new Error(
        `Unauthenticated preview request was not rejected: HTTP ${unauthenticatedResponse.status}`,
      );
    }
    const response = await fetch(`${controlPlaneUrl}${preview.previewUrl}`, {
      headers: { Cookie: `cloudagent_session=${browserToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    const html = await response.text();
    if (!response.ok || !html.includes(marker)) {
      throw new Error(
        `Preview content was not accessible: HTTP ${response.status} ${html.slice(0, 500)}`,
      );
    }
    const assetResponse = await fetch(
      `${controlPlaneUrl}${preview.previewUrl}assets/app.js`,
      {
        headers: { Cookie: `cloudagent_session=${browserToken}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    const asset = await assetResponse.text();
    if (!assetResponse.ok || !asset.includes(marker)) {
      throw new Error(`Nested preview asset was not proxied: HTTP ${assetResponse.status}`);
    }
    await expectAppError(
      () => startTaskPreview(task.id, previewInput, operatorId),
      "TASK_PREVIEW_ALREADY_RUNNING",
    );
    const visibleToMember = await refreshTaskPreview(preview.id, memberId);
    if (visibleToMember.status !== "running") {
      throw new Error("Project member could not observe the running preview");
    }
    if (!visibleToMember.output.includes("GET /")) {
      throw new Error(`Preview runtime logs were not captured: ${visibleToMember.output}`);
    }
    await expectAppError(
      () => stopTaskPreview(preview.id, memberId),
      "FORBIDDEN",
    );
    const stopped = await stopTaskPreview(preview.id, operatorId);
    if (stopped.status !== "stopped" || !stopped.endedAt) {
      throw new Error("Preview did not persist its stopped state");
    }
    const stoppedResponse = await fetch(`${controlPlaneUrl}${preview.previewUrl}`, {
      headers: { Cookie: `cloudagent_session=${browserToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (stoppedResponse.status !== 409) {
      throw new Error(`Stopped preview remained accessible: HTTP ${stoppedResponse.status}`);
    }
    const restarted = await startTaskPreview(task.id, previewInput, operatorId);
    if (restarted.status !== "running" || restarted.id === preview.id) {
      throw new Error("Preview did not restart as a new isolated run");
    }
    const restartedResponse = await fetch(`${controlPlaneUrl}${restarted.previewUrl}`, {
      headers: { Cookie: `cloudagent_session=${browserToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!restartedResponse.ok || !(await restartedResponse.text()).includes(marker)) {
      throw new Error("Restarted preview was not accessible");
    }
    await stopTaskPreview(restarted.id, operatorId);
    const history = await listTaskPreviewRuns(task.id);
    if (history.length !== 2 || history[0]?.id !== restarted.id) {
      throw new Error("Preview history was not persisted");
    }

    console.log(
      JSON.stringify({
        taskId: task.id,
        runnerId: runner.id,
        previewId: preview.id,
        previewUrl: preview.previewUrl,
        memberStartRejected: true,
        memberReadAllowed: true,
        memberStopRejected: true,
        duplicateStartRejected: true,
        previewContentVerified: true,
        nestedAssetVerified: true,
        runtimeLogsCaptured: true,
        unauthenticatedRequestRejected: true,
        stoppedCleanly: true,
        stoppedPreviewRejected: true,
        restartVerified: true,
      }),
    );
  } finally {
    if (taskId) {
      const runner = await getTaskRunner(taskId).catch(() => null);
      if (runner) {
        await destroyRunner(runner).catch(() => undefined);
      }
    }
    await query("DELETE FROM auth_sessions WHERE token_hash = $1", [
      hashSessionToken(browserToken),
    ]).catch(() => undefined);
    await query("DELETE FROM audit_events WHERE project_id = $1 OR actor_id = $2", [
      projectId,
      operatorId,
    ]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await query("DELETE FROM users WHERE id = $1", [operatorId]).catch(() => undefined);
    await rm(workspacePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
