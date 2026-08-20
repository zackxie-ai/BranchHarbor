import { randomUUID } from "node:crypto";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { AppError } from "../apps/control-plane/src/lib/errors";
import {
  addProjectMembership,
  getActiveProjectIntegrationQueue,
  insertChangeRequest,
  insertProject,
  insertTask,
} from "../apps/control-plane/src/lib/repositories";
import {
  cancelProjectIntegrationQueue,
  getChangeRequestIntegrationQueueGate,
  replaceProjectIntegrationQueue,
  reviewChangeRequest,
  startIntegration,
} from "../apps/control-plane/src/lib/services";

const adminId = "00000000-0000-4000-8000-000000000101";
const memberId = randomUUID();
const projectId = randomUUID();

async function expectAppError(action: () => Promise<unknown>, expectedCode: string) {
  try {
    await action();
  } catch (error) {
    if (error instanceof AppError && error.code === expectedCode) return;
    throw error;
  }
  throw new Error(`Expected ${expectedCode}`);
}

async function createSubmittedChange(title: string) {
  const task = await insertTask({
    projectId,
    title,
    description: `${title} integration queue smoke task`,
    acceptanceCriteria: "Queue ordering and gating are enforced.",
    verificationCommands: [],
    expectedChangeScopes: [`src/${title.toLowerCase().replaceAll(" ", "-")}`],
    assignedUserId: adminId,
    actorId: adminId,
  });
  const changeRequest = await insertChangeRequest({
    taskId: task.id,
    summary: `${title} submitted for queue verification.`,
    baseCommit: `base-${task.id}`,
    headCommit: `head-${task.id}`,
    changedFiles: [{ status: "M", path: `src/${task.id}.ts` }],
    diffStat: "1 file changed",
    verificationResults: [],
    risks: [],
    actorId: adminId,
  });
  return { task, changeRequest };
}

async function main() {
  try {
    await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
      memberId,
      `integration-queue-${memberId.slice(0, 8)}@branchharbor.local`,
      "Integration Queue Member",
    ]);
    await query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
      [config.organizationId, memberId],
    );
    await insertProject({
      id: projectId,
      name: "Integration Queue Smoke",
      slug: `integration-queue-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `integration-queue-${projectId.slice(0, 8)}`,
      repositoryUrl: `/tmp/integration-queue-${projectId}`,
      localRepositoryPath: `/tmp/integration-queue-${projectId}`,
      actorId: adminId,
    });
    await addProjectMembership({ projectId, userId: memberId, addedBy: adminId });

    const alpha = await createSubmittedChange("Alpha Foundation");
    const beta = await createSubmittedChange("Beta Feature");
    const outside = await createSubmittedChange("Outside Change");

    await expectAppError(
      () => replaceProjectIntegrationQueue(projectId, {
        source: "deterministic",
        selectedTaskIds: [alpha.task.id, beta.task.id],
      }, memberId),
      "ADMIN_REQUIRED",
    );

    const firstQueue = await replaceProjectIntegrationQueue(projectId, {
      source: "deterministic",
      selectedTaskIds: [beta.task.id, alpha.task.id],
    }, adminId);
    if (firstQueue.items.length !== 2) throw new Error("Queue did not persist both selected tasks");

    const firstItem = firstQueue.items[0]!;
    const secondItem = firstQueue.items[1]!;
    const firstGate = await getChangeRequestIntegrationQueueGate(firstItem.changeRequestId, adminId);
    if (!firstGate.allowed || firstGate.position !== 1) {
      throw new Error(`First queue item was not unlocked: ${JSON.stringify(firstGate)}`);
    }
    const secondGate = await getChangeRequestIntegrationQueueGate(secondItem.changeRequestId, adminId);
    if (secondGate.allowed || secondGate.blockingItems[0]?.taskId !== firstItem.taskId) {
      throw new Error(`Second queue item was not blocked: ${JSON.stringify(secondGate)}`);
    }
    await expectAppError(
      () => startIntegration(secondItem.changeRequestId, adminId),
      "INTEGRATION_QUEUE_BLOCKED",
    );
    await expectAppError(
      () => startIntegration(outside.changeRequest.id, adminId),
      "INTEGRATION_QUEUE_EXCLUDES_CHANGE",
    );

    await reviewChangeRequest(firstItem.changeRequestId, {
      decision: "reject",
      comment: "Reject the first queue item to verify that the next item unlocks.",
    }, adminId);
    const unlockedGate = await getChangeRequestIntegrationQueueGate(secondItem.changeRequestId, adminId);
    if (!unlockedGate.allowed) {
      throw new Error(`Rejected predecessor did not unlock the next item: ${JSON.stringify(unlockedGate)}`);
    }

    const replacementQueue = await replaceProjectIntegrationQueue(projectId, {
      source: "deterministic",
      selectedTaskIds: [secondItem.taskId],
    }, adminId);
    const oldQueueRows = await query<{ status: string }>(
      "SELECT status FROM project_integration_queues WHERE id = $1",
      [firstQueue.id],
    );
    if (oldQueueRows[0]?.status !== "cancelled") {
      throw new Error(`Replacing the queue did not cancel the prior queue: ${JSON.stringify(oldQueueRows)}`);
    }
    await expectAppError(
      () => cancelProjectIntegrationQueue(projectId, {
        reason: "A normal member must not cancel the integration queue.",
      }, memberId),
      "ADMIN_REQUIRED",
    );
    const cancelledQueue = await cancelProjectIntegrationQueue(projectId, {
      reason: "Cancel this queue to verify the audited Admin cancellation path.",
    }, adminId);
    if (cancelledQueue.id !== replacementQueue.id || cancelledQueue.status !== "cancelled") {
      throw new Error("Admin queue cancellation did not return the cancelled queue");
    }

    const completionQueue = await replaceProjectIntegrationQueue(projectId, {
      source: "deterministic",
      selectedTaskIds: [secondItem.taskId],
    }, adminId);
    await reviewChangeRequest(secondItem.changeRequestId, {
      decision: "reject",
      comment: "Reject the final queue item so the active queue becomes completed.",
    }, adminId);
    if (await getActiveProjectIntegrationQueue(projectId)) {
      throw new Error("A fully terminal queue remained active");
    }
    const completionRows = await query<{ status: string }>(
      "SELECT status FROM project_integration_queues WHERE id = $1",
      [completionQueue.id],
    );
    if (completionRows[0]?.status !== "completed") {
      throw new Error(`Final queue was not completed: ${JSON.stringify(completionRows)}`);
    }

    const auditRows = await query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE project_id = $1
          AND event_type IN ('project.integration_queue_replaced', 'project.integration_queue_cancelled')`,
      [projectId],
    );
    const replacementAudits = auditRows.filter((row) => row.event_type === "project.integration_queue_replaced").length;
    const cancellationAudits = auditRows.filter((row) => row.event_type === "project.integration_queue_cancelled").length;
    if (replacementAudits !== 3 || cancellationAudits !== 1) {
      throw new Error(`Queue audit trail is incomplete: ${JSON.stringify(auditRows)}`);
    }
    const runnerRows = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count
         FROM task_runners runner
         JOIN tasks task ON task.id = runner.task_id
        WHERE task.project_id = $1 AND runner.status <> 'destroyed'`,
      [projectId],
    );
    if (runnerRows[0]?.count !== "0") {
      throw new Error(`Queue gate unexpectedly created a Runner: ${runnerRows[0]?.count}`);
    }

    console.log(JSON.stringify({
      firstQueueId: firstQueue.id,
      replacementQueueId: replacementQueue.id,
      completedQueueId: completionQueue.id,
      blockedCode: "INTEGRATION_QUEUE_BLOCKED",
      excludedCode: "INTEGRATION_QUEUE_EXCLUDES_CHANGE",
      replacementAudits,
      cancellationAudits,
    }));
  } finally {
    await query("DELETE FROM audit_events WHERE project_id = $1 OR actor_id = $2", [
      projectId,
      memberId,
    ]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await query("DELETE FROM users WHERE id = $1", [memberId]).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
