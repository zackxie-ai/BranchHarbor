import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { AppError } from "../apps/control-plane/src/lib/errors";
import {
  cloneRepository,
  createTaskWorktree,
} from "../apps/control-plane/src/lib/git";
import {
  addProjectMembership,
  insertProject,
  insertTask,
  updateTaskWorkspace,
} from "../apps/control-plane/src/lib/repositories";
import {
  getProjectNotifications,
  getTaskWorkspaceProgress,
  getTaskWorkspaceProgressHistory,
  markProjectNotificationsRead,
} from "../apps/control-plane/src/lib/services";

const execFileAsync = promisify(execFile);
const adminId = "00000000-0000-4000-8000-000000000101";
const memberId = randomUUID();
const projectId = randomUUID();
const projectRoot = path.join(config.runtimeRoot, "task-workspace-progress-smoke", projectId);
const remotePath = path.join(projectRoot, "origin.git");
const seedPath = path.join(projectRoot, "seed");
const repositoryPath = path.join(projectRoot, "repository");

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
  try {
    await mkdir(projectRoot, { recursive: true });
    await execFileAsync("git", ["init", "--bare", remotePath]);
    await execFileAsync("git", ["init", "-b", "main", seedPath]);
    await git(seedPath, ["config", "user.name", "Workspace Progress Smoke"]);
    await git(seedPath, ["config", "user.email", "workspace-progress@branchharbor.local"]);
    await mkdir(path.join(seedPath, "src/legacy"), { recursive: true });
    await mkdir(path.join(seedPath, "src/users"), { recursive: true });
    await writeFile(path.join(seedPath, "shared.txt"), "base\n");
    await writeFile(path.join(seedPath, "src/legacy/a.ts"), "export const a = 1;\n");
    await writeFile(path.join(seedPath, "src/legacy/b.ts"), "export const b = 1;\n");
    await writeFile(path.join(seedPath, "src/legacy/config.ts"), "export const legacy = true;\n");
    await writeFile(path.join(seedPath, "src/users/model.ts"), "export const userVersion = 1;\n");
    await writeFile(
      path.join(seedPath, "src/users/user.service.ts"),
      'import { userVersion } from "./model";\nexport const currentUserVersion = userVersion;\n',
    );
    await git(seedPath, ["add", "."]);
    await git(seedPath, ["commit", "-m", "Base"]);
    await git(seedPath, ["remote", "add", "origin", remotePath]);
    await git(seedPath, ["push", "-u", "origin", "main"]);
    await execFileAsync("git", ["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await cloneRepository(remotePath, repositoryPath);

    await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
      memberId,
      `workspace-progress-${memberId.slice(0, 8)}@branchharbor.local`,
      "Workspace Progress Member",
    ]);
    await query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
      [config.organizationId, memberId],
    );
    await insertProject({
      id: projectId,
      name: "Task Workspace Progress Smoke",
      slug: `task-workspace-progress-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `task-workspace-progress-${projectId.slice(0, 8)}`,
      repositoryUrl: remotePath,
      localRepositoryPath: repositoryPath,
      actorId: adminId,
    });
    const task = await insertTask({
      projectId,
      title: "Track live Git progress",
      description: "Verify committed, uncommitted and main drift state.",
      acceptanceCriteria: "Every state is derived from Git.",
      verificationCommands: [],
      expectedChangeScopes: ["shared.txt", "draft.txt", "src"],
      assignedUserId: adminId,
      actorId: adminId,
    });
    const workspace = await createTaskWorktree({
      repositoryPath,
      projectId,
      taskId: task.id,
      title: task.title,
      baseBranch: "main",
    });
    await updateTaskWorkspace({ taskId: task.id, ...workspace });

    await expectAppError(() => getTaskWorkspaceProgress(task.id, memberId), "FORBIDDEN");
    await expectAppError(() => getProjectNotifications(projectId, memberId), "FORBIDDEN");
    await expectAppError(
      () => markProjectNotificationsRead(projectId, { notificationIds: [] }, memberId),
      "FORBIDDEN",
    );
    await addProjectMembership({ projectId, userId: memberId, addedBy: adminId });

    const initialProgress = await getTaskWorkspaceProgress(task.id, memberId);
    if (
      initialProgress.committedFiles.length !== 0 ||
      initialProgress.uncommittedFiles.length !== 0 ||
      initialProgress.mainAdvanced
    ) {
      throw new Error(`Initial workspace progress is incorrect: ${JSON.stringify(initialProgress)}`);
    }
    await getTaskWorkspaceProgress(task.id, memberId);
    if ((await getTaskWorkspaceProgressHistory(task.id, memberId)).length !== 1) {
      throw new Error("Unchanged workspace polling created duplicate snapshots");
    }
    if ((await getProjectNotifications(projectId, memberId)).length !== 0) {
      throw new Error("Initial clean workspace created a project notification");
    }

    await writeFile(path.join(seedPath, "main-only.txt"), "main only\n");
    await git(seedPath, ["add", "main-only.txt"]);
    await git(seedPath, ["commit", "-m", "Advance main without overlap"]);
    await git(seedPath, ["push", "origin", "main"]);
    const driftProgress = await getTaskWorkspaceProgress(task.id, memberId);
    if (
      driftProgress.mainCommitsSinceBase !== 1 ||
      !driftProgress.mainAdvanced ||
      driftProgress.overlappingFiles.length !== 0
    ) {
      throw new Error(`Non-overlapping main drift is incorrect: ${JSON.stringify(driftProgress)}`);
    }

    await writeFile(path.join(workspace.worktreePath, "shared.txt"), "task change\n");
    await mkdir(path.join(workspace.worktreePath, "src/core"), { recursive: true });
    await git(workspace.worktreePath, ["mv", "src/legacy/a.ts", "src/core/a.ts"]);
    await git(workspace.worktreePath, ["mv", "src/legacy/b.ts", "src/core/b.ts"]);
    await writeFile(
      path.join(workspace.worktreePath, "src/users/user.service.ts"),
      'import { userVersion } from "./model";\nexport const currentUserVersion = userVersion + 1;\n',
    );
    await git(workspace.worktreePath, ["add", "-A"]);
    await git(workspace.worktreePath, ["commit", "-m", "Move legacy modules and update user service"]);
    await writeFile(path.join(workspace.worktreePath, "draft.txt"), "uncommitted task work\n");
    const taskProgress = await getTaskWorkspaceProgress(task.id, memberId);
    if (
      !taskProgress.committedFiles.some((file) => file.path === "shared.txt") ||
      !taskProgress.committedFiles.some(
        (file) => file.path === "src/core/a.ts" && file.previousPath === "src/legacy/a.ts",
      ) ||
      !taskProgress.committedFiles.some(
        (file) => file.path === "src/core/b.ts" && file.previousPath === "src/legacy/b.ts",
      ) ||
      taskProgress.uncommittedFiles.length !== 1 ||
      taskProgress.uncommittedFiles[0]?.path !== "draft.txt" ||
      taskProgress.overlappingFiles.length !== 0
    ) {
      throw new Error(`Task progress before overlap is incorrect: ${JSON.stringify(taskProgress)}`);
    }

    await writeFile(path.join(seedPath, "shared.txt"), "main change\n");
    await writeFile(
      path.join(seedPath, "src/legacy/config.ts"),
      "export const legacy = false;\n",
    );
    await writeFile(
      path.join(seedPath, "src/users/model.ts"),
      "export const userVersion = 2;\n",
    );
    await git(seedPath, ["add", "shared.txt", "src/legacy/config.ts", "src/users/model.ts"]);
    await git(seedPath, ["commit", "-m", "Create real overlap"]);
    await git(seedPath, ["push", "origin", "main"]);
    const progress = await getTaskWorkspaceProgress(task.id, memberId);
    if (
      !progress.committedFiles.some((file) => file.path === "shared.txt") ||
      progress.uncommittedFiles.length !== 1 ||
      progress.uncommittedFiles[0]?.path !== "draft.txt" ||
      progress.mainCommitsSinceBase !== 2 ||
      !progress.mainAdvanced ||
      JSON.stringify(progress.overlappingFiles) !== JSON.stringify(["shared.txt"])
    ) {
      throw new Error(`Workspace progress is incorrect: ${JSON.stringify(progress)}`);
    }
    if (
      !progress.structuralConflicts.some(
        (conflict) => conflict.kind === "directory_overlap" && conflict.severity === "danger",
      ) ||
      !progress.structuralConflicts.some(
        (conflict) =>
          conflict.kind === "import_dependency" &&
          conflict.taskPath === "src/users/user.service.ts" &&
          conflict.mainPath === "src/users/model.ts",
      )
    ) {
      throw new Error(`Structural conflicts are incomplete: ${JSON.stringify(progress.structuralConflicts)}`);
    }
    if (!progress.mainChangedFiles.some((file) => file.path === "main-only.txt")) {
      throw new Error("Main-only file was not included in drift details");
    }
    await getTaskWorkspaceProgress(task.id, memberId);
    const snapshots = await getTaskWorkspaceProgressHistory(task.id, memberId);
    if (snapshots.length !== 4) {
      throw new Error(`Expected four deduplicated snapshots: ${JSON.stringify(snapshots)}`);
    }
    const notifications = await getProjectNotifications(projectId, memberId);
    const notificationKinds = notifications.map((notification) => notification.kind).sort();
    if (
      JSON.stringify(notificationKinds) !==
      JSON.stringify([
        "main_advanced",
        "task_commit_observed",
        "workspace_overlap",
        "workspace_structural_conflict",
      ])
    ) {
      throw new Error(`Project notifications are incorrect: ${JSON.stringify(notifications)}`);
    }
    if (notifications.some((notification) => notification.read || notification.readAt !== null)) {
      throw new Error(`Member notifications should initially be unread: ${JSON.stringify(notifications)}`);
    }
    const adminNotifications = await getProjectNotifications(projectId, adminId);
    if (adminNotifications.some((notification) => notification.read || notification.readAt !== null)) {
      throw new Error(
        `Admin notifications should initially be unread: ${JSON.stringify(adminNotifications)}`,
      );
    }

    const firstNotificationId = notifications[0]!.id;
    const memberAfterSingleRead = await markProjectNotificationsRead(
      projectId,
      { notificationIds: [firstNotificationId] },
      memberId,
    );
    const memberReadNotification = memberAfterSingleRead.find(
      (notification) => notification.id === firstNotificationId,
    );
    if (
      !memberReadNotification?.read ||
      memberReadNotification.readAt === null ||
      memberAfterSingleRead.filter((notification) => notification.read).length !== 1
    ) {
      throw new Error(
        `Member single-notification read state is incorrect: ${JSON.stringify(memberAfterSingleRead)}`,
      );
    }
    const adminAfterMemberRead = await getProjectNotifications(projectId, adminId);
    if (adminAfterMemberRead.some((notification) => notification.read)) {
      throw new Error(
        `Member read state leaked to Admin: ${JSON.stringify(adminAfterMemberRead)}`,
      );
    }

    const memberAfterReadAll = await markProjectNotificationsRead(
      projectId,
      { notificationIds: [] },
      memberId,
    );
    if (memberAfterReadAll.some((notification) => !notification.read || !notification.readAt)) {
      throw new Error(`Member read-all state is incorrect: ${JSON.stringify(memberAfterReadAll)}`);
    }
    if ((await getProjectNotifications(projectId, adminId)).some((notification) => notification.read)) {
      throw new Error("Member read-all state leaked to Admin");
    }
    await expectAppError(
      () =>
        markProjectNotificationsRead(
          projectId,
          { notificationIds: [randomUUID()] },
          memberId,
        ),
      "PROJECT_NOTIFICATION_INVALID",
    );

    await query("DELETE FROM audit_events WHERE project_id = $1 OR actor_id = $2", [
      projectId,
      memberId,
    ]);
    await query("DELETE FROM users WHERE id = $1", [memberId]);
    const [userReadResidue] = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM project_notification_reads WHERE user_id = $1",
      [memberId],
    );
    if (userReadResidue?.count !== "0") {
      throw new Error(`Deleting a user left notification reads behind: ${userReadResidue?.count}`);
    }
    await query("DELETE FROM projects WHERE id = $1", [projectId]);
    const [orphanReadResidue] = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM project_notification_reads notification_read
         LEFT JOIN project_notifications notification
           ON notification.id = notification_read.notification_id
         LEFT JOIN users read_user ON read_user.id = notification_read.user_id
        WHERE notification.id IS NULL OR read_user.id IS NULL`,
    );
    if (orphanReadResidue?.count !== "0") {
      throw new Error(`Notification read records contain orphans: ${orphanReadResidue?.count}`);
    }

    console.log(
      JSON.stringify({
        unassignedMemberRejected: true,
        unassignedNotificationReadRejected: true,
        projectMemberReadAllowed: true,
        unchangedSnapshotsDeduplicated: true,
        cleanWorkspaceCreatedNoAlert: true,
        committedChangesVisible: true,
        uncommittedChangesVisible: true,
        mainDriftDetected: true,
        nonOverlappingDriftNotified: true,
        overlappingFileDetected: true,
        overlappingFileNotified: true,
        renameSourcePreserved: true,
        directoryMoveConflictDetected: true,
        importDependencyConflictDetected: true,
        structuralConflictNotified: true,
        newCommitNotified: true,
        progressHistoryPersisted: true,
        mainOnlyChangeVisible: true,
        perUserNotificationReadsIsolated: true,
        singleNotificationReadSupported: true,
        allNotificationsReadSupported: true,
        invalidNotificationRejected: true,
        notificationReadCascadeVerified: true,
      }),
    );
  } finally {
    await query("DELETE FROM audit_events WHERE project_id = $1 OR actor_id = $2", [
      projectId,
      memberId,
    ]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await query("DELETE FROM memberships WHERE user_id = $1", [memberId]).catch(() => undefined);
    await query("DELETE FROM users WHERE id = $1", [memberId]).catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
