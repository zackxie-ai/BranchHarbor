import Link from "next/link";

import { ProjectNotifications } from "@/components/project-notifications";
import { ProjectMergePlanPanel } from "@/components/project-merge-plan";
import { ProjectValidationPanel } from "@/components/project-validation-panel";
import { StatusBadge } from "@/components/status-badge";
import { TaskLiveUpdates } from "@/components/task-live-updates";
import { requirePageUser } from "@/lib/auth";
import { requireProjectMembership } from "@/lib/authorization";
import {
  listProjectAgentConnections,
  listProjectMergePlanAgentPermissionRequests,
  listProjectMergePlanAgentSessions,
  listProjectMembers,
  listTaskDependencies,
  listTaskScopeConflicts,
  listTasks,
  listUsers,
} from "@/lib/repositories";
import {
  getLatestProjectMergePlanAgentRun,
  getProjectIntegrationQueue,
  getProjectIntegrationQueueHistory,
  getProjectMergePlan,
  getProjectNotifications,
  getProjectValidationHistory,
} from "@/lib/services";
import {
  addProjectMemberAction,
  createTaskAction,
  removeProjectMemberAction,
} from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const actor = await requirePageUser();
  const { project, role } = await requireProjectMembership(actor.id, projectId);
  const [
    tasks,
    organizationUsers,
    projectMembers,
    agents,
    taskDependencies,
    scopeConflicts,
    notifications,
    mergePlan,
    latestMergePlanAgentRun,
    integrationQueue,
    integrationQueueHistory,
    validationRuns,
  ] = await Promise.all([
    listTasks(projectId),
    listUsers(project.organizationId),
    listProjectMembers(projectId),
    listProjectAgentConnections(projectId),
    listTaskDependencies(projectId),
    listTaskScopeConflicts(projectId),
    getProjectNotifications(projectId, actor.id),
    getProjectMergePlan(projectId, actor.id),
    getLatestProjectMergePlanAgentRun(projectId, actor.id),
    getProjectIntegrationQueue(projectId, actor.id),
    getProjectIntegrationQueueHistory(projectId, actor.id),
    getProjectValidationHistory(projectId, actor.id),
  ]);
  const [mergePlanAgentSessions, mergePlanAgentPermissions] = latestMergePlanAgentRun
    ? await Promise.all([
        listProjectMergePlanAgentSessions(latestMergePlanAgentRun.id),
        listProjectMergePlanAgentPermissionRequests(latestMergePlanAgentRun.id),
      ])
    : [[], []];
  const adminAgents = agents.filter(
    (agent) =>
      agent.userId === actor.id &&
      agent.status === "ready" &&
      agent.credentialConfigured,
  );
  const projectMemberIds = new Set(projectMembers.map((member) => member.id));
  const availableMembers = organizationUsers.filter(
    (user) => user.role === "member" && !projectMemberIds.has(user.id),
  );
  const createForProject = createTaskAction.bind(null, projectId);
  const addMember = addProjectMemberAction.bind(null, projectId);
  const dependenciesByTask = new Map<string, typeof taskDependencies>();
  for (const dependency of taskDependencies) {
    const current = dependenciesByTask.get(dependency.taskId) ?? [];
    current.push(dependency);
    dependenciesByTask.set(dependency.taskId, current);
  }
  const conflictsByTask = new Map<
    string,
    Array<{ otherTaskId: string; otherTaskTitle: string; overlappingScopes: string[] }>
  >();
  for (const conflict of scopeConflicts) {
    const leftConflicts = conflictsByTask.get(conflict.leftTaskId) ?? [];
    leftConflicts.push({
      otherTaskId: conflict.rightTaskId,
      otherTaskTitle: conflict.rightTaskTitle,
      overlappingScopes: conflict.overlaps.map(
        ({ leftScope, rightScope }) => `${leftScope} ↔ ${rightScope}`,
      ),
    });
    conflictsByTask.set(conflict.leftTaskId, leftConflicts);
    const rightConflicts = conflictsByTask.get(conflict.rightTaskId) ?? [];
    rightConflicts.push({
      otherTaskId: conflict.leftTaskId,
      otherTaskTitle: conflict.leftTaskTitle,
      overlappingScopes: conflict.overlaps.map(
        ({ leftScope, rightScope }) => `${rightScope} ↔ ${leftScope}`,
      ),
    });
    conflictsByTask.set(conflict.rightTaskId, rightConflicts);
  }

  return (
    <>
      <TaskLiveUpdates
        sessions={[]}
        hasRunningWorkflow={validationRuns.some((run) => ["queued", "running"].includes(run.status))}
      />
      <section className="section-head">
        <div>
          <span className="eyebrow">{project.giteaOwner}/{project.giteaRepository}</span>
          <h1 style={{ fontSize: 42 }}>{project.name}</h1>
          <p>Canonical repository: <code>{project.repositoryUrl}</code></p>
        </div>
        <a className="button secondary" href={`${process.env.GITEA_BASE_URL ?? "http://localhost:3100"}/${project.giteaOwner}/${project.giteaRepository}`} target="_blank" rel="noreferrer">
          Open Gitea
        </a>
      </section>

      <section className="section-head" id="members">
        <div>
          <h2>Project members</h2>
          <p>Organization Admins have implicit access. Members must join the project before they can view it, operate tasks, or use Runners.</p>
        </div>
      </section>
      <div className="grid two">
        <div className="panel stack">
          {projectMembers.map((member) => (
            <div className="card" key={member.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <strong>{member.name}</strong>
                  <p className="muted">{member.email}</p>
                </div>
                <span className="status status-neutral">
                  {member.role === "admin" ? "Organization Admin" : "Project member"}
                </span>
              </div>
              {role === "admin" && member.role !== "admin" && member.explicitMembership && (
                <form action={removeProjectMemberAction.bind(null, projectId, member.id)}>
                  <button className="button danger" type="submit">Remove from project</button>
                </form>
              )}
            </div>
          ))}
        </div>
        {role === "admin" && (
          <div className="panel">
            <h3>Add organization member</h3>
            {availableMembers.length > 0 ? (
              <form className="form" action={addMember}>
                <label>
                  Select member
                  <select name="userId" required defaultValue={availableMembers[0]?.id}>
                    {availableMembers.map((user) => (
                      <option value={user.id} key={user.id}>{user.name} · {user.email}</option>
                    ))}
                  </select>
                </label>
                <button className="button" type="submit">Add to project</button>
              </form>
            ) : (
              <p className="muted">Every organization member already belongs to this project.</p>
            )}
          </div>
        )}
      </div>

      <ProjectNotifications
        projectId={project.id}
        initialNotifications={notifications}
      />

      <ProjectMergePlanPanel
        projectId={project.id}
        mergePlan={mergePlan}
        isAdmin={role === "admin"}
        adminAgents={adminAgents}
        latestAgentRun={latestMergePlanAgentRun}
        agentSessions={mergePlanAgentSessions}
        permissionRequests={mergePlanAgentPermissions}
        integrationQueue={integrationQueue}
      />

      <ProjectValidationPanel
        projectId={project.id}
        queues={integrationQueueHistory}
        runs={validationRuns}
        isAdmin={role === "admin"}
      />

      <div className="detail-grid">
        <section>
          <div className="section-head">
            <div>
              <h2>Tasks and Worktrees</h2>
              <p>Every task runs in its own branch and directory.</p>
            </div>
          </div>
          <div className="stack">
            {tasks.length ? tasks.map((task) => {
              const dependencies = dependenciesByTask.get(task.id) ?? [];
              const conflicts = conflictsByTask.get(task.id) ?? [];
              return (
                <Link className="card" href={`/tasks/${task.id}`} key={task.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                    <h3>{task.title}</h3>
                    <StatusBadge status={task.status} />
                  </div>
                  <p>{task.description || "No task description"}</p>
                  {task.expectedChangeScopes.length > 0 ? (
                    <div className="coordination-scopes">
                      {task.expectedChangeScopes.map((scope) => <code key={scope}>{scope}</code>)}
                    </div>
                  ) : (
                    <p className="muted">No expected change scopes declared</p>
                  )}
                  {dependencies.length > 0 ? (
                    <p className="coordination-dependencies">
                      Dependencies: {dependencies.map((dependency) => `${dependency.dependsOnTitle} (${dependency.dependsOnStatus})`).join(", ")}
                    </p>
                  ) : null}
                  {conflicts.map((conflict) => (
                    <div className="coordination-warning" key={`${task.id}-${conflict.otherTaskId}`}>
                      <strong>Scope overlap: {conflict.otherTaskTitle}</strong>
                      <span>{conflict.overlappingScopes.join("; ")}</span>
                    </div>
                  ))}
                  <div className="card-meta">
                    <span>{task.assignedUserName}</span>
                    <span>{task.agentDisplayName ?? "No Agent assigned"}</span>
                  </div>
                </Link>
              );
            }) : <div className="empty">No tasks yet.</div>}
          </div>
        </section>

        <aside>
          <div className="section-head">
            <div>
              <h2>Create task</h2>
              <p>Choose the member, Agent, expected change scopes, dependencies, and verification commands.</p>
            </div>
          </div>
          <div className="panel">
            <form className="form" action={createForProject}>
              <label>
                Task title
                <input name="title" required minLength={3} placeholder="Implement the project settings page" />
              </label>
              <label>
                Task description
                <textarea name="description" placeholder="What should the Agent complete?" />
              </label>
              <label>
                Acceptance criteria
                <textarea name="acceptanceCriteria" placeholder="What defines completion?" />
              </label>
              <label>
                Assignee
                <select name="assignedUserId" required defaultValue={projectMembers.find((user) => user.role === "member")?.id ?? actor.id}>
                  {projectMembers.map((user) => <option value={user.id} key={user.id}>{user.name} · {user.role}</option>)}
                </select>
              </label>
              <label>
                Agent
                <select name="agentConnectionId" defaultValue="">
                  <option value="">Choose later</option>
                  {agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName} · {agent.protocol}</option>)}
                </select>
              </label>
              <label>
                Expected change scopes (one repository-relative path per line)
                <textarea name="expectedChangeScopes" required placeholder={"apps/control-plane/src/app\npackages/shared\nREADME.md"} />
              </label>
              {tasks.length > 0 ? (
                <label>
                  Dependencies (multiple selection allowed)
                  <select name="dependsOnTaskIds" multiple size={Math.min(tasks.length, 5)}>
                    {tasks.map((task) => (
                      <option value={task.id} key={task.id}>{task.title} · {task.status}</option>
                    ))}
                  </select>
                  <span className="muted">Hold Command or Ctrl to select multiple tasks. Dependencies guide the Admin's integration order.</span>
                </label>
              ) : null}
              <label>
                Verification commands (one per line)
                <textarea name="verificationCommands" placeholder={"pnpm test\npnpm build"} />
              </label>
              <button className="button" type="submit">Create task</button>
            </form>
          </div>
        </aside>
      </div>
    </>
  );
}
