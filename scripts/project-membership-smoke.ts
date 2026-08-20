import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { requireProjectMembership } from "../apps/control-plane/src/lib/authorization";
import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { AppError } from "../apps/control-plane/src/lib/errors";
import {
  addProjectMembership,
  getProjectAccessRole,
  insertProject,
  listProjectMembers,
  listProjects,
  setTaskStatus,
} from "../apps/control-plane/src/lib/repositories";
import {
  addProjectMember,
  createTask,
  removeProjectMember,
} from "../apps/control-plane/src/lib/services";

const adminId = "00000000-0000-4000-8000-000000000101";
const memberId = randomUUID();
const outsiderId = randomUUID();
const projectId = randomUUID();
const projectRoot = path.join(config.runtimeRoot, "project-membership-smoke", projectId);

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

async function insertMember(userId: string, name: string) {
  await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
    userId,
    `project-member-${userId.slice(0, 8)}@cloudagent.local`,
    name,
  ]);
  await query(
    "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
    [config.organizationId, userId],
  );
}

async function main() {
  try {
    await Promise.all([
      insertMember(memberId, "Project Member"),
      insertMember(outsiderId, "Project Outsider"),
    ]);
    await mkdir(projectRoot, { recursive: true });
    await insertProject({
      id: projectId,
      name: "Project Membership Smoke",
      slug: `project-membership-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `project-membership-${projectId.slice(0, 8)}`,
      repositoryUrl: projectRoot,
      localRepositoryPath: projectRoot,
      actorId: adminId,
    });
    await addProjectMembership({ projectId, userId: memberId, addedBy: adminId });

    await requireProjectMembership(memberId, projectId);
    await expectAppError(() => requireProjectMembership(outsiderId, projectId), "FORBIDDEN");
    if ((await listProjects(outsiderId)).some((project) => project.id === projectId)) {
      throw new Error("Unassigned organization member can see the project");
    }
    await expectAppError(
      () => addProjectMember(projectId, { userId: outsiderId }, memberId),
      "ADMIN_REQUIRED",
    );

    await addProjectMember(projectId, { userId: outsiderId }, adminId);
    await requireProjectMembership(outsiderId, projectId);
    if (!(await listProjects(outsiderId)).some((project) => project.id === projectId)) {
      throw new Error("Added project member cannot see the project");
    }
    const task = await createTask(
      projectId,
      {
        title: "Project member assignment",
        description: "Verify that only project members can own tasks.",
        acceptanceCriteria: "Project membership is enforced.",
        assignedUserId: outsiderId,
        agentConnectionId: null,
        expectedChangeScopes: ["project-membership-smoke"],
        verificationCommands: [],
      },
      memberId,
    );
    await expectAppError(
      () => removeProjectMember(projectId, outsiderId, adminId),
      "PROJECT_MEMBER_HAS_OPEN_TASKS",
    );
    await setTaskStatus(task.id, "cancelled");
    await removeProjectMember(projectId, outsiderId, adminId);
    await expectAppError(() => requireProjectMembership(outsiderId, projectId), "FORBIDDEN");
    await expectAppError(
      () => removeProjectMember(projectId, outsiderId, adminId),
      "PROJECT_MEMBERSHIP_NOT_FOUND",
    );
    await expectAppError(
      () =>
        createTask(
          projectId,
          {
            title: "Invalid outsider assignment",
            description: "This task must not be created.",
            acceptanceCriteria: "Creation is rejected.",
            assignedUserId: outsiderId,
            agentConnectionId: null,
            expectedChangeScopes: ["project-membership-invalid"],
            verificationCommands: [],
          },
          memberId,
        ),
      "FORBIDDEN",
    );
    await expectAppError(
      () => removeProjectMember(projectId, adminId, adminId),
      "PROJECT_ADMIN_ACCESS_IMPLICIT",
    );
    const members = await listProjectMembers(projectId);
    if (!members.some((member) => member.id === adminId && member.role === "admin")) {
      throw new Error("Organization Admin does not have implicit project access");
    }
    if (!members.some((member) => member.id === memberId)) {
      throw new Error("Explicit project member is missing");
    }
    if (members.some((member) => member.id === outsiderId)) {
      throw new Error("Removed project member still appears in the project");
    }
    if ((await getProjectAccessRole(adminId, projectId)) !== "admin") {
      throw new Error("Organization Admin project role was not preserved");
    }
    const [audit] = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count
         FROM audit_events
        WHERE project_id = $1
          AND event_type IN ('project.member_added', 'project.member_removed')`,
      [projectId],
    );
    if (audit?.count !== "2") {
      throw new Error(`Expected two project membership audit events, received ${audit?.count ?? "0"}`);
    }

    console.log(
      JSON.stringify({
        projectId,
        unassignedMemberRejected: true,
        projectListFiltered: true,
        nonAdminManagementRejected: true,
        memberAdded: true,
        taskAssignmentRestricted: true,
        openTaskRemovalRejected: true,
        memberRemoved: true,
        adminAccessImplicit: true,
        auditRecorded: true,
      }),
    );
  } finally {
    await query("DELETE FROM audit_events WHERE project_id = $1 OR actor_id = ANY($2::UUID[])", [
      projectId,
      [memberId, outsiderId],
    ]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await query("DELETE FROM users WHERE id = ANY($1::UUID[])", [[memberId, outsiderId]]).catch(
      () => undefined,
    );
    await rm(projectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
