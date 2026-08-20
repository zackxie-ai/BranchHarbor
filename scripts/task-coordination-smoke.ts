import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { AppError } from "../apps/control-plane/src/lib/errors";
import { cloneRepository, createTaskWorktree } from "../apps/control-plane/src/lib/git";
import {
  insertProject,
  listTaskDependencies,
  listTaskScopeConflicts,
  setTaskStatus,
  updateTaskWorkspace,
} from "../apps/control-plane/src/lib/repositories";
import {
  createTask,
  submitTaskChange,
} from "../apps/control-plane/src/lib/services";

const execFileAsync = promisify(execFile);
const adminId = "00000000-0000-4000-8000-000000000101";
const projectId = randomUUID();
const foreignProjectId = randomUUID();
const projectRoot = path.join(config.runtimeRoot, "task-coordination-smoke", projectId);
const remotePath = path.join(projectRoot, "origin.git");
const seedPath = path.join(projectRoot, "seed");
const repositoryPath = path.join(projectRoot, "repository");
const foreignRepositoryPath = path.join(projectRoot, "foreign-repository");

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
    await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(foreignRepositoryPath, { recursive: true })]);
    await execFileAsync("git", ["init", "--bare", remotePath]);
    await execFileAsync("git", ["init", "-b", "main", seedPath]);
    await git(seedPath, ["config", "user.name", "BranchHarbor Coordination Smoke"]);
    await git(seedPath, ["config", "user.email", "coordination@branchharbor.local"]);
    await mkdir(path.join(seedPath, "apps/control-plane"), { recursive: true });
    await writeFile(path.join(seedPath, "apps/control-plane/base.txt"), "base\n");
    await writeFile(path.join(seedPath, "README.md"), "base readme\n");
    await git(seedPath, ["add", "."]);
    await git(seedPath, ["commit", "-m", "Base"]);
    await git(seedPath, ["remote", "add", "origin", remotePath]);
    await git(seedPath, ["push", "-u", "origin", "main"]);
    await execFileAsync("git", ["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await cloneRepository(remotePath, repositoryPath);

    await insertProject({
      id: projectId,
      name: "Task Coordination Smoke",
      slug: `task-coordination-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `task-coordination-${projectId.slice(0, 8)}`,
      repositoryUrl: repositoryPath,
      localRepositoryPath: repositoryPath,
      actorId: adminId,
    });
    await insertProject({
      id: foreignProjectId,
      name: "Foreign Task Coordination Smoke",
      slug: `task-coordination-foreign-${foreignProjectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `task-coordination-foreign-${foreignProjectId.slice(0, 8)}`,
      repositoryUrl: foreignRepositoryPath,
      localRepositoryPath: foreignRepositoryPath,
      actorId: adminId,
    });

    const taskA = await createTask(
      projectId,
      {
        title: "Control plane foundation",
        description: "Own the control plane module.",
        acceptanceCriteria: "Control plane changes are committed.",
        assignedUserId: adminId,
        agentConnectionId: null,
        expectedChangeScopes: ["./apps/control-plane/**", "apps/control-plane/src"],
        dependsOnTaskIds: [],
        verificationCommands: [],
      },
      adminId,
    );
    if (JSON.stringify(taskA.expectedChangeScopes) !== JSON.stringify(["apps/control-plane"])) {
      throw new Error(`Task scopes were not normalized: ${JSON.stringify(taskA)}`);
    }
    const taskB = await createTask(
      projectId,
      {
        title: "Control plane page",
        description: "Change one page inside the control plane.",
        acceptanceCriteria: "Page is implemented.",
        assignedUserId: adminId,
        agentConnectionId: null,
        expectedChangeScopes: ["apps/control-plane/src/app"],
        dependsOnTaskIds: [taskA.id],
        verificationCommands: [],
      },
      adminId,
    );
    const taskC = await createTask(
      projectId,
      {
        title: "Documentation only",
        description: "Update documentation without touching the app.",
        acceptanceCriteria: "Documentation is updated.",
        assignedUserId: adminId,
        agentConnectionId: null,
        expectedChangeScopes: ["docs"],
        dependsOnTaskIds: [],
        verificationCommands: [],
      },
      adminId,
    );
    const foreignTask = await createTask(
      foreignProjectId,
      {
        title: "Foreign prerequisite",
        description: "Must not be accepted as a dependency.",
        acceptanceCriteria: "Cross-project dependency is rejected.",
        assignedUserId: adminId,
        agentConnectionId: null,
        expectedChangeScopes: ["foreign"],
        dependsOnTaskIds: [],
        verificationCommands: [],
      },
      adminId,
    );
    await expectAppError(
      () =>
        createTask(
          projectId,
          {
            title: "Invalid cross-project dependency",
            description: "This task must not be created.",
            acceptanceCriteria: "Creation is rejected.",
            assignedUserId: adminId,
            agentConnectionId: null,
            expectedChangeScopes: ["invalid"],
            dependsOnTaskIds: [foreignTask.id],
            verificationCommands: [],
          },
          adminId,
        ),
      "TASK_DEPENDENCY_INVALID",
    );

    const dependencies = await listTaskDependencies(projectId);
    if (
      dependencies.length !== 1 ||
      dependencies[0]?.taskId !== taskB.id ||
      dependencies[0]?.dependsOnTaskId !== taskA.id
    ) {
      throw new Error(`Task dependency was not persisted: ${JSON.stringify(dependencies)}`);
    }
    const conflicts = await listTaskScopeConflicts(projectId);
    const conflictingTaskIds = new Set([
      conflicts[0]?.leftTaskId,
      conflicts[0]?.rightTaskId,
    ]);
    if (
      conflicts.length !== 1 ||
      !conflictingTaskIds.has(taskA.id) ||
      !conflictingTaskIds.has(taskB.id) ||
      conflicts.some(
        (conflict) => conflict.leftTaskId === taskC.id || conflict.rightTaskId === taskC.id,
      )
    ) {
      throw new Error(`Task scope conflict detection failed: ${JSON.stringify(conflicts)}`);
    }

    const taskAWorkspace = await createTaskWorktree({
      repositoryPath,
      projectId,
      taskId: taskA.id,
      title: taskA.title,
      baseBranch: "main",
    });
    await updateTaskWorkspace({ taskId: taskA.id, ...taskAWorkspace });
    await writeFile(path.join(taskAWorkspace.worktreePath, "README.md"), "out of declared scope\n");
    await git(taskAWorkspace.worktreePath, ["add", "README.md"]);
    await git(taskAWorkspace.worktreePath, ["commit", "-m", "Change outside declared scope"]);
    const changeRequest = await submitTaskChange(
      taskA.id,
      { summary: "Verify that BranchHarbor reports committed files outside the declared task scope.", risks: [] },
      adminId,
    );
    if (!changeRequest.risks.some((risk) => risk.includes("README.md"))) {
      throw new Error(`Out-of-scope change was not reported: ${JSON.stringify(changeRequest.risks)}`);
    }

    await setTaskStatus(taskA.id, "merged");
    if ((await listTaskScopeConflicts(projectId)).length !== 0) {
      throw new Error("Merged task still participates in active scope conflicts");
    }

    const renameTask = await createTask(
      projectId,
      {
        title: "Move documentation into control plane",
        description: "Verify rename source paths remain in scope validation.",
        acceptanceCriteria: "The old path is checked as well as the new path.",
        assignedUserId: adminId,
        agentConnectionId: null,
        expectedChangeScopes: ["apps/control-plane"],
        dependsOnTaskIds: [],
        verificationCommands: [],
      },
      adminId,
    );
    const renameWorkspace = await createTaskWorktree({
      repositoryPath,
      projectId,
      taskId: renameTask.id,
      title: renameTask.title,
      baseBranch: "main",
    });
    await updateTaskWorkspace({ taskId: renameTask.id, ...renameWorkspace });
    await git(renameWorkspace.worktreePath, ["mv", "README.md", "apps/control-plane/README.md"]);
    await git(renameWorkspace.worktreePath, ["commit", "-m", "Move README into declared scope"]);
    const renameChangeRequest = await submitTaskChange(
      renameTask.id,
      {
        summary: "Verify the source path of a Git rename remains subject to declared scope checks.",
        risks: [],
      },
      adminId,
    );
    if (!renameChangeRequest.risks.some((risk) => risk.includes("README.md"))) {
      throw new Error(
        `Rename source path bypassed scope validation: ${JSON.stringify(renameChangeRequest)}`,
      );
    }

    const [audit] = await query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events
        WHERE task_id = $1 AND event_type = 'task.created'
        ORDER BY created_at DESC LIMIT 1`,
      [taskB.id],
    );
    if (
      JSON.stringify(audit?.payload.expectedChangeScopes) !==
        JSON.stringify(["apps/control-plane/src/app"]) ||
      JSON.stringify(audit?.payload.dependsOnTaskIds) !== JSON.stringify([taskA.id])
    ) {
      throw new Error(`Task coordination audit is incomplete: ${JSON.stringify(audit)}`);
    }

    console.log(
      JSON.stringify({
        scopesNormalized: true,
        dependencyPersisted: true,
        crossProjectDependencyRejected: true,
        overlapDetected: true,
        unrelatedTaskIgnored: true,
        outOfScopeChangeReported: true,
        renameSourceScopeChecked: true,
        terminalTaskReleasedSoftLock: true,
        coordinationAuditRecorded: true,
      }),
    );
  } finally {
    await query("DELETE FROM audit_events WHERE project_id IN ($1,$2)", [
      projectId,
      foreignProjectId,
    ]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id IN ($1,$2)", [projectId, foreignProjectId]).catch(
      () => undefined,
    );
    await rm(projectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
