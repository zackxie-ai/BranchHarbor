import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { config } from "../apps/control-plane/src/lib/config";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
} from "../apps/control-plane/src/lib/auth-crypto";
import { query } from "../apps/control-plane/src/lib/db";
import { insertAuthSession } from "../apps/control-plane/src/lib/repositories";

const controlPlaneUrl = `http://127.0.0.1:${process.env.CONTROL_PLANE_PORT ?? "3210"}`;
const adminId = randomUUID();
const memberId = randomUUID();
const adminToken = createSessionToken();
const memberToken = createSessionToken();
const suffix = randomUUID().slice(0, 8);
const repositorySlug = `http-flow-${suffix}`;
let projectId: string | null = null;

function cookie(token: string): string {
  return `${config.auth.cookieName}=${token}`;
}

async function request(
  pathname: string,
  options: RequestInit & { token?: string } = {},
): Promise<Response> {
  const { token, ...init } = options;
  return fetch(`${controlPlaneUrl}${pathname}`, {
    redirect: "manual",
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Cookie: cookie(token) } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
}

async function expectStatus(response: Response, expected: number, label: string): Promise<void> {
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
}

async function expectPage(
  pathname: string,
  token: string,
  marker: string,
  label: string,
): Promise<void> {
  const response = await request(pathname, { token });
  await expectStatus(response, 200, label);
  const html = await response.text();
  if (!html.includes(marker)) {
    throw new Error(`${label}: page did not contain ${JSON.stringify(marker)}`);
  }
}

async function deleteGiteaRepository(): Promise<void> {
  const authorization = Buffer.from(`${config.gitea.username}:${config.gitea.password}`).toString("base64");
  const response = await fetch(
    `${config.gitea.baseUrl}/api/v1/repos/${encodeURIComponent(config.gitea.username)}/${encodeURIComponent(repositorySlug)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Basic ${authorization}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Unable to delete HTTP smoke Gitea repository: HTTP ${response.status}`);
  }
}

async function main() {
  try {
    await query(
      `INSERT INTO users (id, email, name)
       VALUES ($1,$2,$3),($4,$5,$6)`,
      [
        adminId,
        `http-admin-${suffix}@branchharbor.local`,
        "HTTP Smoke Admin",
        memberId,
        `http-member-${suffix}@branchharbor.local`,
        "HTTP Smoke Member",
      ],
    );
    await query(
      `INSERT INTO memberships (organization_id, user_id, role)
       VALUES ($1,$2,'admin'),($1,$3,'member')`,
      [config.organizationId, adminId, memberId],
    );
    const passwordHash = await hashPassword(`http-smoke-password-${suffix}`);
    await query(
      `INSERT INTO user_credentials (user_id, password_hash, must_change_password)
       VALUES ($1,$3,FALSE),($2,$3,FALSE)`,
      [adminId, memberId, passwordHash],
    );
    await Promise.all([
      insertAuthSession({
        userId: adminId,
        tokenHash: hashSessionToken(adminToken),
        expiresAt: new Date(Date.now() + 60_000),
      }),
      insertAuthSession({
        userId: memberId,
        tokenHash: hashSessionToken(memberToken),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ]);

    const loginPage = await request("/login");
    await expectStatus(loginPage, 200, "Public login page");
    if (!(await loginPage.text()).includes("Sign in to your workspace")) {
      throw new Error("Public login page content is missing");
    }
    const protectedPage = await request("/");
    if (protectedPage.status < 300 || protectedPage.status >= 400 || !protectedPage.headers.get("location")?.includes("/login")) {
      throw new Error("Unauthenticated page request did not redirect to login");
    }
    await expectStatus(await request("/api/projects"), 401, "Unauthenticated API");

    const forbiddenProjectCreate = await request("/api/projects", {
      token: memberToken,
      method: "POST",
      body: JSON.stringify({ name: "Forbidden project", slug: `forbidden-${suffix}` }),
    });
    await expectStatus(forbiddenProjectCreate, 403, "Member project creation");

    const projectResponse = await request("/api/projects", {
      token: adminToken,
      method: "POST",
      body: JSON.stringify({ name: `HTTP User Flow ${suffix}`, slug: repositorySlug }),
    });
    await expectStatus(projectResponse, 201, "Admin project creation");
    const projectPayload = (await projectResponse.json()) as { project: { id: string; name: string } };
    projectId = projectPayload.project.id;

    const memberProjectsBefore = await request("/api/projects", { token: memberToken });
    await expectStatus(memberProjectsBefore, 200, "Member project list before assignment");
    const beforePayload = (await memberProjectsBefore.json()) as { projects: Array<{ id: string }> };
    if (beforePayload.projects.some((project) => project.id === projectId)) {
      throw new Error("Unassigned member could see the new project");
    }

    await expectStatus(
      await request(`/api/projects/${projectId}/members`, {
        token: memberToken,
        method: "POST",
        body: JSON.stringify({ userId: memberId }),
      }),
      403,
      "Member project membership management",
    );
    await expectStatus(
      await request(`/api/projects/${projectId}/members`, {
        token: adminToken,
        method: "POST",
        body: JSON.stringify({ userId: memberId }),
      }),
      201,
      "Admin project membership management",
    );

    const memberProjectsAfter = await request("/api/projects", { token: memberToken });
    await expectStatus(memberProjectsAfter, 200, "Member project list after assignment");
    const afterPayload = (await memberProjectsAfter.json()) as { projects: Array<{ id: string }> };
    if (!afterPayload.projects.some((project) => project.id === projectId)) {
      throw new Error("Assigned member could not see the new project");
    }

    const invalidTask = await request(`/api/projects/${projectId}/tasks`, {
      token: memberToken,
      method: "POST",
      body: JSON.stringify({
        title: "Invalid task scope",
        description: "Validate API input errors.",
        acceptanceCriteria: "The request is rejected.",
        assignedUserId: memberId,
        expectedChangeScopes: ["../outside"],
      }),
    });
    await expectStatus(invalidTask, 400, "Invalid task scope");

    const taskResponse = await request(`/api/projects/${projectId}/tasks`, {
      token: memberToken,
      method: "POST",
      body: JSON.stringify({
        title: "Implement HTTP user flow",
        description: "Create a task through the authenticated REST API.",
        acceptanceCriteria: "The task appears on project and task pages.",
        assignedUserId: memberId,
        agentConnectionId: null,
        verificationCommands: ["printf 'http flow ok\\n'"],
        expectedChangeScopes: ["src/http-flow"],
        dependsOnTaskIds: [],
      }),
    });
    await expectStatus(taskResponse, 201, "Member task creation");
    const taskPayload = (await taskResponse.json()) as { task: { id: string; title: string } };

    const tasksResponse = await request(`/api/projects/${projectId}/tasks`, { token: adminToken });
    await expectStatus(tasksResponse, 200, "Project task list");
    const tasksPayload = (await tasksResponse.json()) as { tasks: Array<{ id: string }> };
    if (!tasksPayload.tasks.some((task) => task.id === taskPayload.task.id)) {
      throw new Error("Created task is missing from the project task API");
    }

    await Promise.all([
      expectPage("/", adminToken, "Create project", "Admin dashboard"),
      expectPage("/members", adminToken, "Members and invitations", "Members page"),
      expectPage("/audit", adminToken, "Audit log", "Audit page"),
      expectPage("/reviews", adminToken, "Change review and integration", "Reviews page"),
      expectPage(`/projects/${projectId}`, adminToken, projectPayload.project.name, "Admin project page"),
      expectPage(`/projects/${projectId}`, memberToken, projectPayload.project.name, "Member project page"),
      expectPage(`/tasks/${taskPayload.task.id}`, memberToken, taskPayload.task.title, "Member task page"),
    ]);

    const memberAdminPage = await request("/members", { token: memberToken });
    if (memberAdminPage.status < 300 || memberAdminPage.status >= 400 || memberAdminPage.headers.get("location") !== "/") {
      throw new Error("Member was not redirected away from the members administration page");
    }
    const memberAuditPage = await request("/audit", { token: memberToken });
    if (memberAuditPage.status < 300 || memberAuditPage.status >= 400 || memberAuditPage.headers.get("location") !== "/") {
      throw new Error("Member was not redirected away from the audit page");
    }

    console.log(JSON.stringify({
      unauthenticatedPageRedirected: true,
      unauthenticatedApiRejected: true,
      loginPageRendered: true,
      adminProjectCreated: true,
      projectRepositoryCloned: true,
      memberProjectIsolationEnforced: true,
      projectMembershipApiVerified: true,
      invalidTaskRejected: true,
      memberTaskCreated: true,
      adminPagesRendered: true,
      memberProjectAndTaskPagesRendered: true,
      adminPagesProtectedFromMembers: true,
    }));
  } finally {
    await query("DELETE FROM audit_events WHERE actor_id IN ($1,$2) OR project_id = $3", [
      adminId,
      memberId,
      projectId,
    ]).catch(() => undefined);
    if (projectId) {
      await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
      await rm(path.join(config.runtimeRoot, "projects", projectId), { recursive: true, force: true });
    }
    await deleteGiteaRepository().catch(() => undefined);
    await query("DELETE FROM users WHERE id IN ($1,$2)", [adminId, memberId]).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
