import { randomUUID } from "node:crypto";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { AppError } from "../apps/control-plane/src/lib/errors";
import {
  addProjectMembership,
  getTask,
  insertChangeRequest,
  insertProject,
  listBlockingTaskDependencies,
  listProjectNotifications,
  listTaskDependenciesForTask,
  listTaskDependencyRevisions,
  setTaskStatus,
} from "../apps/control-plane/src/lib/repositories";
import {
  cancelTask,
  createTask,
  getTaskDependencyHistory,
  recoverTaskDependency,
  reviewChangeRequest,
  startIntegration,
  updateTaskDependencies,
} from "../apps/control-plane/src/lib/services";
import type {
  TaskDependencyRevision,
  TaskDependencyRevisionEntry,
} from "../apps/control-plane/src/lib/types";

const adminId = "00000000-0000-4000-8000-000000000101";
const memberId = randomUUID();
const projectId = randomUUID();
const foreignProjectId = randomUUID();
const slugSuffix = projectId.slice(0, 8);

async function expectAppError(
  action: () => Promise<unknown>,
  expectedCode: string,
): Promise<AppError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AppError && error.code === expectedCode) return error;
    throw error;
  }
  throw new Error(`Expected ${expectedCode}`);
}

async function expectDependencies(taskId: string, expectedIds: string[]): Promise<void> {
  const dependencies = await listTaskDependenciesForTask(taskId);
  const actualIds = dependencies.map((dependency) => dependency.dependsOnTaskId).sort();
  const normalizedExpectedIds = [...expectedIds].sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(normalizedExpectedIds)) {
    throw new Error(
      `Unexpected dependencies for ${taskId}: ${JSON.stringify(dependencies)}`,
    );
  }
}

function expectRevisionEntries(
  label: string,
  actual: TaskDependencyRevisionEntry[],
  expected: TaskDependencyRevisionEntry[],
): void {
  const actualValues = actual.map((entry) => [entry.taskId, entry.title, entry.status]);
  const expectedValues = expected.map((entry) => [entry.taskId, entry.title, entry.status]);
  if (JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function expectRevision(
  revision: TaskDependencyRevision | undefined,
  expected: {
    actorId: string;
    actorName: string;
    changeKind: TaskDependencyRevision["changeKind"];
    changeReason: string | null;
    previousDependencies: TaskDependencyRevisionEntry[];
    nextDependencies: TaskDependencyRevisionEntry[];
    addedDependencies: TaskDependencyRevisionEntry[];
    removedDependencies: TaskDependencyRevisionEntry[];
  },
): void {
  if (!revision) throw new Error("Expected dependency revision");
  if (revision.actorId !== expected.actorId || revision.actorName !== expected.actorName) {
    throw new Error(`Unexpected dependency revision actor: ${JSON.stringify(revision)}`);
  }
  if (
    revision.changeKind !== expected.changeKind ||
    revision.changeReason !== expected.changeReason
  ) {
    throw new Error(`Unexpected dependency revision metadata: ${JSON.stringify(revision)}`);
  }
  expectRevisionEntries(
    "Previous dependency snapshot",
    revision.previousDependencies,
    expected.previousDependencies,
  );
  expectRevisionEntries(
    "Next dependency snapshot",
    revision.nextDependencies,
    expected.nextDependencies,
  );
  expectRevisionEntries(
    "Added dependency snapshot",
    revision.addedDependencies,
    expected.addedDependencies,
  );
  expectRevisionEntries(
    "Removed dependency snapshot",
    revision.removedDependencies,
    expected.removedDependencies,
  );
}

async function expectRevisionCount(taskId: string, expectedCount: number): Promise<void> {
  const revisions = await listTaskDependencyRevisions(taskId);
  if (revisions.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} dependency revisions for ${taskId}, got ${revisions.length}`,
    );
  }
}

async function countDependencyAudits(taskIds: string[]): Promise<number> {
  const [result] = await query<{ count: number }>(
    `SELECT COUNT(*)::INT AS count
       FROM audit_events
      WHERE event_type = 'task.dependencies_updated'
        AND task_id = ANY($1::UUID[])`,
    [taskIds],
  );
  return result?.count ?? 0;
}

async function main() {
  try {
    await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
      memberId,
      `task-dependency-management-${memberId.slice(0, 8)}@branchharbor.local`,
      "Dependency Management Member",
    ]);
    await query(
      `INSERT INTO memberships (organization_id, user_id, role)
       VALUES ($1,$2,'member')`,
      [config.organizationId, memberId],
    );

    await insertProject({
      id: projectId,
      name: "Task Dependency Management Smoke",
      slug: `task-dependency-management-${slugSuffix}`,
      giteaOwner: "smoke",
      giteaRepository: `task-dependency-management-${slugSuffix}`,
      repositoryUrl: `/tmp/task-dependency-management-${slugSuffix}`,
      localRepositoryPath: `/tmp/task-dependency-management-${slugSuffix}`,
      actorId: adminId,
    });
    await insertProject({
      id: foreignProjectId,
      name: "Foreign Task Dependency Management Smoke",
      slug: `task-dependency-management-foreign-${slugSuffix}`,
      giteaOwner: "smoke",
      giteaRepository: `task-dependency-management-foreign-${slugSuffix}`,
      repositoryUrl: `/tmp/task-dependency-management-foreign-${slugSuffix}`,
      localRepositoryPath: `/tmp/task-dependency-management-foreign-${slugSuffix}`,
      actorId: adminId,
    });
    await addProjectMembership({ projectId, userId: memberId, addedBy: adminId });

    const taskInput = {
      description: "Verify editable task dependency ordering.",
      acceptanceCriteria: "Dependency rules and integration gate are enforced.",
      assignedUserId: adminId,
      agentConnectionId: null,
      expectedChangeScopes: ["src"],
      dependsOnTaskIds: [],
      verificationCommands: [],
    };
    const taskA = await createTask(
      projectId,
      { ...taskInput, title: "Foundation task A" },
      adminId,
    );
    const taskB = await createTask(
      projectId,
      { ...taskInput, title: "Dependent task B" },
      adminId,
    );
    const taskC = await createTask(
      projectId,
      { ...taskInput, title: "Independent task C" },
      adminId,
    );
    const taskWithInitialDependency = await createTask(
      projectId,
      {
        ...taskInput,
        title: "Task created with dependency",
        dependsOnTaskIds: [taskA.id],
      },
      adminId,
    );
    const foreignTask = await createTask(
      foreignProjectId,
      { ...taskInput, title: "Foreign project task" },
      adminId,
    );
    const failedDependency = await createTask(
      projectId,
      { ...taskInput, title: "Cancelled prerequisite" },
      adminId,
    );
    const failedReplacement = await createTask(
      projectId,
      { ...taskInput, title: "Cancelled replacement" },
      adminId,
    );
    const validReplacement = await createTask(
      projectId,
      { ...taskInput, title: "Valid replacement" },
      adminId,
    );
    const recoveryTask = await createTask(
      projectId,
      {
        ...taskInput,
        title: "Task requiring replacement recovery",
        dependsOnTaskIds: [failedDependency.id],
      },
      adminId,
    );
    const removalRecoveryTask = await createTask(
      projectId,
      {
        ...taskInput,
        title: "Task requiring removal recovery",
        dependsOnTaskIds: [failedReplacement.id],
      },
      adminId,
    );
    const rejectedDependency = await createTask(
      projectId,
      { ...taskInput, title: "Rejected prerequisite" },
      adminId,
    );
    const rejectedRecoveryTask = await createTask(
      projectId,
      {
        ...taskInput,
        title: "Task blocked by rejected prerequisite",
        dependsOnTaskIds: [rejectedDependency.id],
      },
      adminId,
    );

    const initialDependencySnapshot = [
      { taskId: taskA.id, title: taskA.title, status: taskA.status },
    ];
    const initialCreationHistory = await listTaskDependencyRevisions(
      taskWithInitialDependency.id,
    );
    if (initialCreationHistory.length !== 1) {
      throw new Error(
        `Expected one initial dependency revision, got ${initialCreationHistory.length}`,
      );
    }
    expectRevision(initialCreationHistory[0], {
      actorId: adminId,
      actorName: "BranchHarbor Admin",
      changeKind: "task_created",
      changeReason: null,
      previousDependencies: [],
      nextDependencies: initialDependencySnapshot,
      addedDependencies: initialDependencySnapshot,
      removedDependencies: [],
    });
    const memberVisibleCreationHistory = await getTaskDependencyHistory(
      taskWithInitialDependency.id,
      memberId,
    );
    if (memberVisibleCreationHistory[0]?.id !== initialCreationHistory[0]?.id) {
      throw new Error("Project member could not read initial dependency history");
    }

    await cancelTask(failedDependency.id, adminId);
    await cancelTask(failedReplacement.id, adminId);
    await cancelTask(failedDependency.id, adminId);
    const rejectedChangeRequest = await insertChangeRequest({
      taskId: rejectedDependency.id,
      summary: "Reject this prerequisite to verify dependent recovery notifications.",
      baseCommit: "3".repeat(40),
      headCommit: "4".repeat(40),
      changedFiles: [],
      diffStat: "0 files changed",
      verificationResults: [],
      risks: [],
      actorId: adminId,
    });
    await reviewChangeRequest(
      rejectedChangeRequest.id,
      { decision: "reject", comment: "The prerequisite does not meet acceptance criteria." },
      adminId,
    );
    const dependencyFailureNotifications = (
      await listProjectNotifications(projectId, memberId, 100)
    ).filter((notification) => notification.kind === "dependency_failed");
    const notifiedTaskIds = dependencyFailureNotifications
      .map((notification) => notification.taskId)
      .sort();
    const expectedNotifiedTaskIds = [
      recoveryTask.id,
      removalRecoveryTask.id,
      rejectedRecoveryTask.id,
    ].sort();
    if (JSON.stringify(notifiedTaskIds) !== JSON.stringify(expectedNotifiedTaskIds)) {
      throw new Error(
        `Unexpected dependency failure notifications: ${JSON.stringify(dependencyFailureNotifications)}`,
      );
    }

    await expectAppError(
      () => updateTaskDependencies(recoveryTask.id, { dependsOnTaskIds: [] }, adminId),
      "TASK_DEPENDENCY_RECOVERY_REQUIRED",
    );
    await expectDependencies(recoveryTask.id, [failedDependency.id]);
    await expectRevisionCount(recoveryTask.id, 1);

    await expectAppError(
      () =>
        createTask(
          projectId,
          {
            ...taskInput,
            title: "Invalid task with failed initial dependency",
            dependsOnTaskIds: [failedDependency.id],
          },
          adminId,
        ),
      "TASK_DEPENDENCY_FAILED",
    );

    await expectAppError(
      () =>
        updateTaskDependencies(
          taskC.id,
          { dependsOnTaskIds: [failedDependency.id] },
          adminId,
        ),
      "TASK_DEPENDENCY_FAILED",
    );
    await expectDependencies(taskC.id, []);
    await expectRevisionCount(taskC.id, 0);

    await expectAppError(
      () =>
        recoverTaskDependency(
          recoveryTask.id,
          {
            failedDependencyTaskId: failedDependency.id,
            replacementTaskId: validReplacement.id,
            reason: "Member must not be able to recover project dependencies.",
          },
          memberId,
        ),
      "ADMIN_REQUIRED",
    );
    await expectRevisionCount(recoveryTask.id, 1);

    await expectAppError(
      () =>
        recoverTaskDependency(
          taskWithInitialDependency.id,
          {
            failedDependencyTaskId: taskA.id,
            replacementTaskId: null,
            reason: "A healthy dependency cannot use the failure recovery endpoint.",
          },
          adminId,
        ),
      "TASK_DEPENDENCY_NOT_FAILED",
    );
    await expectRevisionCount(taskWithInitialDependency.id, 1);

    await expectAppError(
      () =>
        recoverTaskDependency(
          recoveryTask.id,
          {
            failedDependencyTaskId: failedDependency.id,
            replacementTaskId: failedReplacement.id,
            reason: "A cancelled task must not replace another failed dependency.",
          },
          adminId,
        ),
      "TASK_DEPENDENCY_REPLACEMENT_FAILED",
    );
    await expectDependencies(recoveryTask.id, [failedDependency.id]);
    await expectRevisionCount(recoveryTask.id, 1);

    await expectAppError(
      () =>
        recoverTaskDependency(
          recoveryTask.id,
          {
            failedDependencyTaskId: failedDependency.id,
            replacementTaskId: foreignTask.id,
            reason: "A foreign project task must not become the replacement dependency.",
          },
          adminId,
        ),
      "TASK_DEPENDENCY_INVALID",
    );
    await expectDependencies(recoveryTask.id, [failedDependency.id]);
    await expectRevisionCount(recoveryTask.id, 1);

    const replacementReason =
      "The valid replacement task covers the cancelled prerequisite acceptance criteria.";
    await recoverTaskDependency(
      recoveryTask.id,
      {
        failedDependencyTaskId: failedDependency.id,
        replacementTaskId: validReplacement.id,
        reason: replacementReason,
      },
      adminId,
    );
    await expectDependencies(recoveryTask.id, [validReplacement.id]);
    const replacementHistory = await getTaskDependencyHistory(recoveryTask.id, memberId);
    if (replacementHistory.length !== 2) {
      throw new Error(`Expected replacement recovery history, got ${replacementHistory.length}`);
    }
    expectRevision(replacementHistory[0], {
      actorId: adminId,
      actorName: "BranchHarbor Admin",
      changeKind: "failure_recovery",
      changeReason: replacementReason,
      previousDependencies: [
        {
          taskId: failedDependency.id,
          title: failedDependency.title,
          status: "cancelled",
        },
      ],
      nextDependencies: [
        {
          taskId: validReplacement.id,
          title: validReplacement.title,
          status: validReplacement.status,
        },
      ],
      addedDependencies: [
        {
          taskId: validReplacement.id,
          title: validReplacement.title,
          status: validReplacement.status,
        },
      ],
      removedDependencies: [
        {
          taskId: failedDependency.id,
          title: failedDependency.title,
          status: "cancelled",
        },
      ],
    });

    const removalReason =
      "The dependent task no longer needs the cancelled prerequisite after scope review.";
    await recoverTaskDependency(
      removalRecoveryTask.id,
      {
        failedDependencyTaskId: failedReplacement.id,
        replacementTaskId: null,
        reason: removalReason,
      },
      adminId,
    );
    await expectDependencies(removalRecoveryTask.id, []);
    const removalRecoveryHistory = await getTaskDependencyHistory(
      removalRecoveryTask.id,
      memberId,
    );
    if (removalRecoveryHistory.length !== 2) {
      throw new Error(`Expected removal recovery history, got ${removalRecoveryHistory.length}`);
    }
    expectRevision(removalRecoveryHistory[0], {
      actorId: adminId,
      actorName: "BranchHarbor Admin",
      changeKind: "failure_recovery",
      changeReason: removalReason,
      previousDependencies: [
        {
          taskId: failedReplacement.id,
          title: failedReplacement.title,
          status: "cancelled",
        },
      ],
      nextDependencies: [],
      addedDependencies: [],
      removedDependencies: [
        {
          taskId: failedReplacement.id,
          title: failedReplacement.title,
          status: "cancelled",
        },
      ],
    });

    const rejectedRemovalReason =
      "The rejected prerequisite is waived because the dependent task now owns that scope.";
    await recoverTaskDependency(
      rejectedRecoveryTask.id,
      {
        failedDependencyTaskId: rejectedDependency.id,
        replacementTaskId: null,
        reason: rejectedRemovalReason,
      },
      adminId,
    );
    await expectDependencies(rejectedRecoveryTask.id, []);
    const rejectedRecoveryHistory = await getTaskDependencyHistory(
      rejectedRecoveryTask.id,
      memberId,
    );
    expectRevision(rejectedRecoveryHistory[0], {
      actorId: adminId,
      actorName: "BranchHarbor Admin",
      changeKind: "failure_recovery",
      changeReason: rejectedRemovalReason,
      previousDependencies: [
        {
          taskId: rejectedDependency.id,
          title: rejectedDependency.title,
          status: "rejected",
        },
      ],
      nextDependencies: [],
      addedDependencies: [],
      removedDependencies: [
        {
          taskId: rejectedDependency.id,
          title: rejectedDependency.title,
          status: "rejected",
        },
      ],
    });

    const [recoveryAuditCount] = await query<{ count: number }>(
      `SELECT COUNT(*)::INT AS count
         FROM audit_events
        WHERE event_type = 'task.dependency_recovered'
          AND task_id = ANY($1::UUID[])`,
      [[recoveryTask.id, removalRecoveryTask.id, rejectedRecoveryTask.id]],
    );
    if (recoveryAuditCount?.count !== 3) {
      throw new Error(`Expected three recovery audit events, got ${recoveryAuditCount?.count}`);
    }

    await updateTaskDependencies(taskB.id, { dependsOnTaskIds: [taskA.id] }, adminId);
    await expectDependencies(taskB.id, [taskA.id]);
    const additionSnapshot = [
      { taskId: taskA.id, title: taskA.title, status: taskA.status },
    ];
    const additionHistory = await listTaskDependencyRevisions(taskB.id);
    if (additionHistory.length !== 1) {
      throw new Error(`Expected one dependency addition revision, got ${additionHistory.length}`);
    }
    expectRevision(additionHistory[0], {
      actorId: adminId,
      actorName: "BranchHarbor Admin",
      changeKind: "manual_update",
      changeReason: null,
      previousDependencies: [],
      nextDependencies: additionSnapshot,
      addedDependencies: additionSnapshot,
      removedDependencies: [],
    });

    await updateTaskDependencies(taskB.id, { dependsOnTaskIds: [taskA.id] }, adminId);
    await expectRevisionCount(taskB.id, 1);
    if ((await countDependencyAudits([taskB.id])) !== 1) {
      throw new Error("Saving unchanged dependencies created an extra audit event");
    }

    await expectAppError(
      () => updateTaskDependencies(taskB.id, { dependsOnTaskIds: [taskC.id] }, memberId),
      "ADMIN_REQUIRED",
    );
    await expectDependencies(taskB.id, [taskA.id]);
    await expectRevisionCount(taskB.id, 1);

    await expectAppError(
      () => updateTaskDependencies(taskB.id, { dependsOnTaskIds: [taskB.id] }, adminId),
      "TASK_DEPENDENCY_SELF_REFERENCE",
    );
    await expectDependencies(taskB.id, [taskA.id]);
    await expectRevisionCount(taskB.id, 1);

    await expectAppError(
      () =>
        updateTaskDependencies(
          taskB.id,
          { dependsOnTaskIds: [foreignTask.id] },
          adminId,
        ),
      "TASK_DEPENDENCY_INVALID",
    );
    await expectDependencies(taskB.id, [taskA.id]);
    await expectRevisionCount(taskB.id, 1);

    await expectAppError(
      () => updateTaskDependencies(taskA.id, { dependsOnTaskIds: [taskB.id] }, adminId),
      "TASK_DEPENDENCY_CYCLE",
    );
    await expectDependencies(taskA.id, []);
    await expectDependencies(taskB.id, [taskA.id]);
    await expectRevisionCount(taskA.id, 0);
    await expectRevisionCount(taskB.id, 1);

    await setTaskStatus(taskC.id, "integrating");
    await expectAppError(
      () => updateTaskDependencies(taskC.id, { dependsOnTaskIds: [taskA.id] }, adminId),
      "TASK_DEPENDENCIES_LOCKED",
    );
    await expectDependencies(taskC.id, []);
    await expectRevisionCount(taskC.id, 0);

    const changeRequest = await insertChangeRequest({
      taskId: taskB.id,
      summary: "Verify that unresolved task dependencies block integration startup.",
      baseCommit: "1".repeat(40),
      headCommit: "2".repeat(40),
      changedFiles: [],
      diffStat: "0 files changed",
      verificationResults: [],
      risks: [],
      actorId: adminId,
    });
    await query(
      "UPDATE change_requests SET status = 'approved_for_integration' WHERE id = $1",
      [changeRequest.id],
    );

    const unresolvedError = await expectAppError(
      () => startIntegration(changeRequest.id, adminId),
      "TASK_DEPENDENCIES_UNRESOLVED",
    );
    if (!unresolvedError.message.includes(taskA.title)) {
      throw new Error(`Dependency blocker message is incomplete: ${unresolvedError.message}`);
    }
    const [resourceCounts] = await query<{ integrations: number; runners: number }>(
      `SELECT
         (SELECT COUNT(*)::INT FROM integration_runs WHERE change_request_id = $1) AS integrations,
         (SELECT COUNT(*)::INT
            FROM task_runners runner
            JOIN integration_runs integration ON integration.id = runner.integration_id
           WHERE integration.change_request_id = $1) AS runners`,
      [changeRequest.id],
    );
    if (resourceCounts?.integrations !== 0 || resourceCounts.runners !== 0) {
      throw new Error(`Blocked integration created resources: ${JSON.stringify(resourceCounts)}`);
    }
    if ((await getTask(taskB.id)).status !== "submitted") {
      throw new Error("Blocked integration changed the dependent task status");
    }

    await setTaskStatus(taskA.id, "merged");
    if ((await listBlockingTaskDependencies(taskB.id)).length !== 0) {
      throw new Error("Merged prerequisite still blocks dependent task integration");
    }

    await updateTaskDependencies(taskB.id, { dependsOnTaskIds: [] }, adminId);
    await expectDependencies(taskB.id, []);

    const finalHistory = await getTaskDependencyHistory(taskB.id, memberId);
    if (finalHistory.length !== 2) {
      throw new Error(`Expected two dependency revisions, got ${finalHistory.length}`);
    }
    const [removalRevision, additionRevision] = finalHistory;
    const mergedDependencySnapshot = [
      { taskId: taskA.id, title: taskA.title, status: "merged" as const },
    ];
    expectRevision(removalRevision, {
      actorId: adminId,
      actorName: "BranchHarbor Admin",
      changeKind: "manual_update",
      changeReason: null,
      previousDependencies: mergedDependencySnapshot,
      nextDependencies: [],
      addedDependencies: [],
      removedDependencies: mergedDependencySnapshot,
    });
    if (additionRevision?.id !== additionHistory[0]?.id) {
      throw new Error("Dependency revision history is not newest-first");
    }
    expectRevision(additionRevision, {
      actorId: adminId,
      actorName: "BranchHarbor Admin",
      changeKind: "manual_update",
      changeReason: null,
      previousDependencies: [],
      nextDependencies: additionSnapshot,
      addedDependencies: additionSnapshot,
      removedDependencies: [],
    });

    const auditCount = await countDependencyAudits([taskA.id, taskB.id, taskC.id]);
    if (auditCount !== 2) {
      throw new Error(`Expected two successful dependency audit events, got ${auditCount}`);
    }

    await query("DELETE FROM audit_events WHERE project_id = ANY($1::UUID[]) OR actor_id = $2", [
      [projectId, foreignProjectId],
      memberId,
    ]);
    await query("DELETE FROM projects WHERE id = ANY($1::UUID[])", [
      [projectId, foreignProjectId],
    ]);
    const [revisionResidue] = await query<{ count: number }>(
      `SELECT COUNT(*)::INT AS count
         FROM task_dependency_revisions
        WHERE project_id = ANY($1::UUID[])`,
      [[projectId, foreignProjectId]],
    );
    if (revisionResidue?.count !== 0) {
      throw new Error(`Dependency revision cleanup left ${revisionResidue?.count} rows`);
    }

    console.log(
      JSON.stringify({
        initialDependenciesRevisioned: true,
        dependencyReplacementPersisted: true,
        dependencyHistoryVisibleToMembers: true,
        dependencySnapshotsPreserved: true,
        failedDependencyNotificationsCreated: true,
        failedDependencyNotificationsDeduplicated: true,
        rejectedDependencyNotificationCreated: true,
        manualFailureRecoveryBypassRejected: true,
        failedInitialDependencyRejected: true,
        failedDependencyAdditionRejected: true,
        memberRecoveryRejected: true,
        healthyDependencyRecoveryRejected: true,
        failedReplacementRejectedTransactionally: true,
        crossProjectRecoveryRejectedTransactionally: true,
        failedDependencyReplacementRecovered: true,
        failedDependencyRemovalRecovered: true,
        recoveryReasonRevisioned: true,
        recoveryActionsAudited: true,
        unchangedDependenciesIgnored: true,
        memberMutationRejected: true,
        selfDependencyRejected: true,
        crossProjectDependencyRejected: true,
        cycleRejectedTransactionally: true,
        terminalDependencyMutationRejected: true,
        failedUpdatesCreatedNoRevisions: true,
        unresolvedDependencyBlockedIntegration: true,
        blockedIntegrationCreatedNoResources: true,
        mergedDependencyReleasedGate: true,
        dependencyRemovalPersisted: true,
        successfulUpdatesAudited: true,
        dependencyRevisionsCascadeDeleted: true,
      }),
    );
  } finally {
    await query("DELETE FROM audit_events WHERE project_id = ANY($1::UUID[]) OR actor_id = $2", [
      [projectId, foreignProjectId],
      memberId,
    ]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id = ANY($1::UUID[])", [
      [projectId, foreignProjectId],
    ]).catch(() => undefined);
    await query("DELETE FROM memberships WHERE user_id = $1", [memberId]).catch(
      () => undefined,
    );
    await query("DELETE FROM users WHERE id = $1", [memberId]).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
