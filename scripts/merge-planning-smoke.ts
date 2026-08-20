import { randomUUID } from "node:crypto";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { AppError } from "../apps/control-plane/src/lib/errors";
import {
  addProjectMembership,
  captureTaskWorkspaceSnapshot,
  insertProject,
  insertTask,
  replaceTaskDependencies,
  setTaskStatus,
} from "../apps/control-plane/src/lib/repositories";
import { getProjectMergePlan } from "../apps/control-plane/src/lib/services";

const adminId = "00000000-0000-4000-8000-000000000101";
const memberId = randomUUID();
const outsiderId = randomUUID();
const projectId = randomUUID();

async function insertMember(userId: string, label: string) {
  await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
    userId,
    `merge-planning-${label}-${userId.slice(0, 8)}@branchharbor.local`,
    `Merge Planning ${label}`,
  ]);
  await query(
    "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
    [config.organizationId, userId],
  );
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

async function createTask(input: {
  title: string;
  scopes: string[];
  status: "submitted" | "changes_requested" | "rejected";
}) {
  const task = await insertTask({
    projectId,
    title: input.title,
    description: `${input.title} merge planning smoke task`,
    acceptanceCriteria: "Appear in the correct merge plan position.",
    verificationCommands: [],
    expectedChangeScopes: input.scopes,
    assignedUserId: adminId,
    actorId: adminId,
  });
  await setTaskStatus(task.id, input.status);
  return { ...task, status: input.status };
}

async function main() {
  try {
    await Promise.all([
      insertMember(memberId, "Member"),
      insertMember(outsiderId, "Outsider"),
    ]);
    await insertProject({
      id: projectId,
      name: "Merge Planning Smoke",
      slug: `merge-planning-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `merge-planning-${projectId.slice(0, 8)}`,
      repositoryUrl: `/tmp/merge-planning-${projectId}`,
      localRepositoryPath: `/tmp/merge-planning-${projectId}`,
      actorId: adminId,
    });
    await addProjectMembership({ projectId, userId: memberId, addedBy: adminId });

    const foundation = await createTask({
      title: "Foundation API",
      scopes: ["src/api"],
      status: "submitted",
    });
    const dashboard = await createTask({
      title: "Dashboard",
      scopes: ["src/dashboard"],
      status: "submitted",
    });
    const client = await createTask({
      title: "API Client",
      scopes: ["src/api/client"],
      status: "submitted",
    });
    const documentation = await createTask({
      title: "Documentation",
      scopes: ["docs"],
      status: "submitted",
    });
    const rejectedPrerequisite = await createTask({
      title: "Rejected Schema",
      scopes: ["src/schema"],
      status: "submitted",
    });
    const blocked = await createTask({
      title: "Blocked Migration",
      scopes: ["src/migrations"],
      status: "submitted",
    });
    const changesRequested = await createTask({
      title: "Needs Revision",
      scopes: ["src/revision"],
      status: "changes_requested",
    });

    await replaceTaskDependencies({
      taskId: dashboard.id,
      dependsOnTaskIds: [foundation.id],
      actorId: adminId,
    });
    await replaceTaskDependencies({
      taskId: client.id,
      dependsOnTaskIds: [foundation.id],
      actorId: adminId,
    });
    await replaceTaskDependencies({
      taskId: blocked.id,
      dependsOnTaskIds: [rejectedPrerequisite.id],
      actorId: adminId,
    });
    await setTaskStatus(rejectedPrerequisite.id, "rejected");
    await captureTaskWorkspaceSnapshot({
      projectId,
      taskId: client.id,
      taskTitle: client.title,
      observedBy: adminId,
      progress: {
        baseCommit: "base",
        headCommit: "client-head",
        mainCommit: "main-new",
        committedFiles: [{ status: "M", path: "src/api/client.ts" }],
        uncommittedFiles: [],
        actualChangedFiles: ["src/api/client.ts"],
        mainChangedFiles: [{ status: "M", path: "src/api/client.ts" }],
        overlappingFiles: ["src/api/client.ts"],
        structuralConflicts: [
          {
            kind: "import_dependency",
            severity: "warning",
            taskPath: "src/api/client.ts",
            mainPath: "src/api/types.ts",
            message: "API client imports types changed on main",
          },
        ],
        mainCommitsSinceBase: 2,
        mainAdvanced: true,
        workingTreeClean: true,
        checkedAt: new Date().toISOString(),
      },
    });

    await expectAppError(() => getProjectMergePlan(projectId, outsiderId), "FORBIDDEN");
    const adminPlan = await getProjectMergePlan(projectId, adminId);
    const memberPlan = await getProjectMergePlan(projectId, memberId);
    if (JSON.stringify(adminPlan.items) !== JSON.stringify(memberPlan.items)) {
      throw new Error("Admin and project member received different merge recommendations");
    }
    const positions = new Map(adminPlan.items.map((item) => [item.taskId, item.position]));
    if (
      !positions.has(foundation.id) ||
      !positions.has(dashboard.id) ||
      !positions.has(client.id) ||
      positions.get(foundation.id)! >= positions.get(dashboard.id)! ||
      positions.get(foundation.id)! >= positions.get(client.id)!
    ) {
      throw new Error(`Dependency order is incorrect: ${JSON.stringify(adminPlan)}`);
    }
    const clientPlan = adminPlan.items.find((item) => item.taskId === client.id);
    if (
      clientPlan?.riskLevel !== "high" ||
      JSON.stringify(clientPlan.actualOverlappingFiles) !== JSON.stringify(["src/api/client.ts"]) ||
      clientPlan.structuralConflicts.length !== 1
    ) {
      throw new Error(`Real Git risk was not included: ${JSON.stringify(clientPlan)}`);
    }
    const blockedPlan = adminPlan.items.find((item) => item.taskId === blocked.id);
    if (
      blockedPlan?.readiness !== "blocked_by_dependency" ||
      blockedPlan.blockingDependencies[0]?.status !== "rejected" ||
      !blockedPlan.requiresDependencyRepair ||
      blockedPlan.position !== adminPlan.items.length ||
      adminPlan.readyTaskIds.includes(blocked.id)
    ) {
      throw new Error(`Rejected dependency was not blocking: ${JSON.stringify(blockedPlan)}`);
    }
    const revisionPlan = adminPlan.items.find((item) => item.taskId === changesRequested.id);
    if (revisionPlan?.readiness !== "changes_requested") {
      throw new Error(`Changes-requested task readiness is incorrect: ${JSON.stringify(revisionPlan)}`);
    }
    if (!adminPlan.readyTaskIds.includes(documentation.id) || adminPlan.hasDependencyCycle) {
      throw new Error(`Ready task or cycle state is incorrect: ${JSON.stringify(adminPlan)}`);
    }

    console.log(
      JSON.stringify({
        outsiderRejected: true,
        memberSharedPlanAllowed: true,
        dependencyOrderPreserved: true,
        foundationPrioritized: positions.get(foundation.id) === 1,
        realGitOverlapRaisedRisk: true,
        structuralRiskIncluded: true,
        rejectedDependencyBlocked: true,
        changesRequestedNotReady: true,
        readyTaskIds: adminPlan.readyTaskIds,
        orderedTaskTitles: adminPlan.items.map((item) => item.title),
      }),
    );
  } finally {
    await query("DELETE FROM audit_events WHERE project_id = $1 OR actor_id IN ($2,$3)", [
      projectId,
      memberId,
      outsiderId,
    ]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await query("DELETE FROM memberships WHERE user_id IN ($1,$2)", [memberId, outsiderId]).catch(
      () => undefined,
    );
    await query("DELETE FROM users WHERE id IN ($1,$2)", [memberId, outsiderId]).catch(
      () => undefined,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
