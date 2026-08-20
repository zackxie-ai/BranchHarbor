import Link from "next/link";

import {
  cancelAgentSessionAction,
  cancelTaskAction,
  provisionWorkspaceAction,
  recoverTaskDependencyAction,
  resolveAgentPermissionAction,
  runTaskAgentAction,
  startTaskPreviewAction,
  startTaskRunnerAction,
  stopTaskPreviewAction,
  submitTaskAction,
  updateTaskDependenciesAction,
} from "@/app/actions";
import { StatusBadge } from "@/components/status-badge";
import { TaskLiveUpdates } from "@/components/task-live-updates";
import { TaskPreviewLive } from "@/components/task-preview-live";
import { TaskWorkspaceProgressPanel } from "@/components/task-workspace-progress";
import { requirePageUser } from "@/lib/auth";
import { requireTaskMembership } from "@/lib/authorization";
import {
  getAgentConnection,
  getTaskRunner,
  listAgentPermissionRequests,
  listAgentSessions,
  listTaskDependencies,
  listTaskPreviewRuns,
  listTaskScopeConflicts,
  listTasks,
  listWorkflowExecutions,
} from "@/lib/repositories";
import {
  getTaskDependencyHistory,
  getTaskWorkspaceBackup,
  getTaskWorkspaceProgress,
  getTaskWorkspaceProgressHistory,
} from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function TaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const actor = await requirePageUser();
  const { task, project, role } = await requireTaskMembership(actor.id, taskId);
  const canOperate = role === "admin" || task.assignedUserId === actor.id;
  const shouldTrackWorkspaceProgress =
    Boolean(task.worktreePath && task.baseCommit) &&
    !["merged", "rejected", "cancelled"].includes(task.status);
  const [
    runner,
    agentSessions,
    agentConnection,
    workflowExecutions,
    permissionRequests,
    previewRuns,
    projectDependencies,
    projectScopeConflicts,
    initialWorkspaceProgress,
    projectTasks,
    dependencyHistory,
  ] = await Promise.all([
    getTaskRunner(task.id),
    listAgentSessions(task.id),
    task.agentConnectionId ? getAgentConnection(task.agentConnectionId) : null,
    listWorkflowExecutions("task", task.id),
    listAgentPermissionRequests(task.id),
    listTaskPreviewRuns(task.id),
    listTaskDependencies(project.id),
    listTaskScopeConflicts(project.id),
    shouldTrackWorkspaceProgress
      ? getTaskWorkspaceProgress(task.id, actor.id).catch(() => null)
      : null,
    listTasks(project.id),
    getTaskDependencyHistory(task.id, actor.id),
  ]);
  const initialWorkspaceSnapshots = await getTaskWorkspaceProgressHistory(
    task.id,
    actor.id,
  );
  const initialWorkspaceBackup = await getTaskWorkspaceBackup(task.id, actor.id);
  const dependencies = projectDependencies.filter((dependency) => dependency.taskId === task.id);
  const blockingDependencies = dependencies.filter(
    (dependency) => dependency.dependsOnStatus !== "merged",
  );
  const failedDependencies = blockingDependencies.filter((dependency) =>
    ["rejected", "cancelled"].includes(dependency.dependsOnStatus),
  );
  const dependencyCandidates = projectTasks.filter((candidate) => candidate.id !== task.id);
  const recoveryReplacementCandidates = dependencyCandidates.filter(
    (candidate) => !["rejected", "cancelled"].includes(candidate.status),
  );
  const canEditDependencies =
    role === "admin" &&
    !["integrating", "merged", "rejected", "cancelled"].includes(task.status);
  const scopeConflicts = projectScopeConflicts
    .filter((conflict) => conflict.leftTaskId === task.id || conflict.rightTaskId === task.id)
    .map((conflict) => ({
      otherTaskId:
        conflict.leftTaskId === task.id ? conflict.rightTaskId : conflict.leftTaskId,
      otherTaskTitle:
        conflict.leftTaskId === task.id ? conflict.rightTaskTitle : conflict.leftTaskTitle,
      overlaps: conflict.overlaps.map(({ leftScope, rightScope }) =>
        conflict.leftTaskId === task.id
          ? `${leftScope} ↔ ${rightScope}`
          : `${rightScope} ↔ ${leftScope}`,
      ),
    }));
  const provision = provisionWorkspaceAction.bind(null, task.id);
  const startRunner = startTaskRunnerAction.bind(null, task.id);
  const startPreview = startTaskPreviewAction.bind(null, task.id);
  const cancelTask = cancelTaskAction.bind(null, task.id);
  const submit = submitTaskAction.bind(null, task.id);
  const runAgent = runTaskAgentAction.bind(null, task.id);
  const updateDependencies = updateTaskDependenciesAction.bind(null, task.id);
  const recoverDependency = recoverTaskDependencyAction.bind(null, task.id);
  const liveSessions = agentSessions.map((session) => ({
    id: session.id,
    status: session.status,
    lastSequence: session.events?.at(-1)?.sequenceNumber ?? 0,
  }));
  const hasRunningWorkflow = workflowExecutions.some((execution) => execution.status === "running");
  const latestPreview = previewRuns[0] ?? null;
  const activePreview = latestPreview && ["starting", "running"].includes(latestPreview.status)
    ? latestPreview
    : null;
  const canStartPreview =
    runner?.status === "running" &&
    canOperate &&
    !activePreview &&
    ["workspace_ready", "active", "changes_requested"].includes(task.status);

  return (
    <>
      <TaskLiveUpdates sessions={liveSessions} hasRunningWorkflow={hasRunningWorkflow} />
      <section className="section-head">
        <div>
          <Link className="eyebrow" href={`/projects/${project.id}`}>← {project.name}</Link>
          <h1 style={{ fontSize: 42 }}>{task.title}</h1>
          <p>{task.description || "No task description"}</p>
        </div>
        <StatusBadge status={task.status} />
      </section>

      <div className="detail-grid">
        <div className="stack">
          <section className="panel">
            <h2>Task definition</h2>
            <div className="divider" />
            <dl className="definition">
              <dt>Assignee</dt><dd>{task.assignedUserName}</dd>
              <dt>Agent</dt><dd>{task.agentDisplayName ?? "Not assigned"}</dd>
              <dt>Acceptance criteria</dt><dd>{task.acceptanceCriteria || "Not provided"}</dd>
              <dt>Expected change scopes</dt><dd>{task.expectedChangeScopes.length ? task.expectedChangeScopes.map((scope) => <code key={scope} style={{ display: "block" }}>{scope}</code>) : "Not provided"}</dd>
              <dt>Dependencies</dt><dd>{dependencies.length ? dependencies.map((dependency) => <span key={dependency.dependsOnTaskId} style={{ display: "block" }}>{dependency.dependsOnTitle} · <code>{dependency.dependsOnStatus}</code></span>) : "None"}</dd>
              <dt>Scope conflicts</dt><dd>{scopeConflicts.length ? scopeConflicts.map((conflict) => <span className="coordination-warning" key={conflict.otherTaskId}><strong>{conflict.otherTaskTitle}</strong><span>{conflict.overlaps.join("; ")}</span></span>) : "None detected"}</dd>
              <dt>Verification commands</dt><dd>{task.verificationCommands.length ? task.verificationCommands.map((command) => <code key={command} style={{ display: "block" }}>{command}</code>) : "Not configured"}</dd>
              <dt>Base branch</dt><dd><code>{task.baseBranch}</code></dd>
              <dt>Task branch</dt><dd><code>{task.branchName ?? "Not created"}</code></dd>
              <dt>Base Commit</dt><dd><code>{task.baseCommit ?? "Not created"}</code></dd>
            </dl>
          </section>

          {blockingDependencies.length > 0 && (
            <section className="panel" id="dependency-blockers">
              <span className="eyebrow">Integration Gate</span>
              <h2 style={{ marginTop: 8 }}>Integration blocked by dependencies</h2>
              <p>These prerequisite tasks must merge into <code>main</code> before this task can enter integration:</p>
              <ul>
                {blockingDependencies.map((dependency) => (
                  <li key={dependency.dependsOnTaskId}>
                    <Link href={`/tasks/${dependency.dependsOnTaskId}`}>
                      {dependency.dependsOnTitle}
                    </Link>{" "}
                    · <code>{dependency.dependsOnStatus}</code>
                  </li>
                ))}
              </ul>
              {failedDependencies.length > 0 ? (
                <div className="coordination-warning coordination-danger">
                  <strong>A dependency failed and waiting will not recover it</strong>
                  <span>An Admin must remove the failed dependency or replace it with a valid task and provide a recovery reason.</span>
                </div>
              ) : null}
              {role === "admin" && canEditDependencies && failedDependencies.length > 0 ? (
                <div className="stack" style={{ marginTop: 16 }}>
                  {failedDependencies.map((dependency) => (
                    <form className="form card" action={recoverDependency} key={dependency.dependsOnTaskId}>
                      <input
                        type="hidden"
                        name="failedDependencyTaskId"
                        value={dependency.dependsOnTaskId}
                      />
                      <strong>Recover: {dependency.dependsOnTitle}</strong>
                      <label>
                        Recovery action
                        <select name="replacementTaskId" defaultValue="">
                          <option value="">Remove the failed dependency without a replacement</option>
                          {recoveryReplacementCandidates
                            .filter((candidate) => candidate.id !== dependency.dependsOnTaskId)
                            .map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                Replace with {candidate.title} · {candidate.status}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        Recovery reason
                        <textarea
                          name="reason"
                          minLength={10}
                          maxLength={1000}
                          required
                          placeholder="Explain why the dependency can be removed or how the replacement covers its responsibility"
                        />
                      </label>
                      <button className="button danger" type="submit">Confirm dependency recovery</button>
                    </form>
                  ))}
                </div>
              ) : null}
            </section>
          )}

          {role === "admin" && (
            <section className="panel" id="dependencies">
              <span className="eyebrow">Admin Coordination</span>
              <h2 style={{ marginTop: 8 }}>Edit task dependencies</h2>
              <p>Select the prerequisite tasks that must complete first to control a safe integration order.</p>
              {canEditDependencies ? (
                <form className="form" action={updateDependencies}>
                  {dependencyCandidates.length > 0 ? (
                    <label>
                      Prerequisite tasks (multiple selection allowed)
                      <select
                        name="dependsOnTaskIds"
                        multiple
                        size={Math.min(Math.max(dependencyCandidates.length, 3), 8)}
                        defaultValue={dependencies.map(
                          (dependency) => dependency.dependsOnTaskId,
                        )}
                      >
                        {dependencyCandidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.title} · {candidate.status}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <p className="muted">This project has no other tasks available as prerequisites.</p>
                  )}
                  <p className="muted auth-note">
                    Hold Command on macOS or Ctrl on Windows/Linux to select multiple tasks. Clear all selections to remove dependencies. Cross-project, self, and cyclic dependencies are rejected.
                  </p>
                  <button className="button" type="submit">Save task dependencies</button>
                </form>
              ) : (
                <p className="muted">Dependencies lock after integration starts or the task reaches a terminal state, preventing order changes during execution.</p>
              )}
            </section>
          )}

          {dependencyHistory.length > 0 ? (
            <section className="panel" id="dependency-history">
              <span className="eyebrow">Coordination Audit</span>
              <h2 style={{ marginTop: 8 }}>Dependency change history</h2>
              <p>Records task creation and every successful dependency change. Invalid, cyclic, and no-op requests do not create revisions.</p>
              <div className="dependency-history-list">
                {dependencyHistory.map((revision) => (
                  <article className="dependency-history-item" key={revision.id}>
                    <div className="notification-head">
                      <strong>
                        {revision.actorName} · {revision.changeKind === "task_created"
                          ? "Task created"
                          : revision.changeKind === "failure_recovery"
                            ? "Failure recovery"
                            : "Manual edit"}
                      </strong>
                      <time dateTime={revision.createdAt.toISOString()}>
                        {revision.createdAt.toLocaleString("en-US", { hour12: false })}
                      </time>
                    </div>
                    {revision.addedDependencies.length > 0 ? (
                      <p>
                        <span className="dependency-change-label dependency-added">Added</span>{" "}
                        {revision.addedDependencies.map((dependency, index) => (
                          <span key={dependency.taskId}>
                            {index > 0 ? ", " : ""}
                            <Link href={`/tasks/${dependency.taskId}`}>{dependency.title}</Link>
                            <code> {dependency.status}</code>
                          </span>
                        ))}
                      </p>
                    ) : null}
                    {revision.removedDependencies.length > 0 ? (
                      <p>
                        <span className="dependency-change-label dependency-removed">Removed</span>{" "}
                        {revision.removedDependencies.map((dependency, index) => (
                          <span key={dependency.taskId}>
                            {index > 0 ? ", " : ""}
                            <Link href={`/tasks/${dependency.taskId}`}>{dependency.title}</Link>
                            <code> {dependency.status}</code>
                          </span>
                        ))}
                      </p>
                    ) : null}
                    {revision.changeReason ? (
                      <p><strong>Reason:</strong> {revision.changeReason}</p>
                    ) : null}
                    <small className="muted">
                      Dependencies after change: {revision.nextDependencies.length > 0
                        ? revision.nextDependencies.map((dependency) => dependency.title).join(", ")
                        : "None"}
                    </small>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {shouldTrackWorkspaceProgress || initialWorkspaceSnapshots.length > 0 ? (
            <TaskWorkspaceProgressPanel
              taskId={task.id}
              initialProgress={initialWorkspaceProgress}
              initialSnapshots={initialWorkspaceSnapshots}
              initialBackup={initialWorkspaceBackup}
              pollingEnabled={shouldTrackWorkspaceProgress}
            />
          ) : null}

          {task.worktreePath && (
            <section className="panel">
              <span className="eyebrow">Member workspace</span>
              <h2 style={{ marginTop: 8 }}>Isolated Worktree ready</h2>
              <p>Connect the member's Codex, Claude Code, or another Agent to this directory:</p>
              <pre>{task.worktreePath}</pre>
              <p className="muted">The Agent can modify only this Worktree. It must create a Git Commit before submitting a change request.</p>
            </section>
          )}

          {runner && (
            <section className="panel">
              <span className="eyebrow">AIO Sandbox</span>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginTop: 8 }}>
                <h2>Isolated Runner</h2>
                <StatusBadge status={runner.status} />
              </div>
              <p>This container mounts only the current task Worktree. Verification and Agent tool calls execute inside it.</p>
              <dl className="definition">
                <dt>Container</dt><dd><code>{runner.containerName}</code></dd>
                <dt>Image</dt><dd><code>{runner.image}</code></dd>
                <dt>Resources</dt><dd>{runner.resourceLimits.cpus} CPU · {runner.resourceLimits.memory} RAM</dd>
                <dt>Workspace</dt><dd><code>{runner.containerWorkspacePath}</code></dd>
              </dl>
              {runner.status === "running" && canOperate && (
                <div className="button-row" style={{ marginTop: 20 }}>
                  <a className="button" href={`/api/runners/${runner.id}/access?surface=code-server`} target="_blank" rel="noreferrer">Open code-server</a>
                  <a className="button secondary" href={`/api/runners/${runner.id}/access?surface=vnc`} target="_blank" rel="noreferrer">Open VNC</a>
                  <a className="button secondary" href={`/api/runners/${runner.id}/access`} target="_blank" rel="noreferrer">Runner console</a>
                </div>
              )}
            </section>
          )}

          {latestPreview && (
            <TaskPreviewLive
              initialPreview={{
                id: latestPreview.id,
                command: latestPreview.command,
                port: latestPreview.port,
                status: latestPreview.status,
                previewUrl: latestPreview.previewUrl,
                output: latestPreview.output,
                exitCode: latestPreview.exitCode,
                errorMessage: latestPreview.errorMessage,
              }}
              stopAction={
                activePreview && canOperate
                  ? stopTaskPreviewAction.bind(null, task.id, activePreview.id)
                  : undefined
              }
            />
          )}

          {canStartPreview && (
            <section className="panel" id="start-preview">
              <span className="eyebrow">Live Application Preview</span>
              <h2 style={{ marginTop: 8 }}>{latestPreview ? "Restart application preview" : "Start application preview"}</h2>
              <p>
                The command runs continuously in the current task Runner and Worktree. The platform exposes a protected preview URL and collects logs.
              </p>
              <form className="form" action={startPreview}>
                <label>
                  Start command
                  <input
                    name="command"
                    required
                    minLength={2}
                    maxLength={2000}
                    defaultValue="pnpm dev -- --host 0.0.0.0 --port $PORT"
                  />
                </label>
                <label>
                  Application port
                  <input name="port" type="number" min={1024} max={65535} defaultValue={3000} required />
                </label>
                <p className="muted auth-note">
                  CloudAgent sets <code>PORT</code>, <code>HOST</code>, and <code>HOSTNAME</code>. If the framework ignores them, bind <code>0.0.0.0</code> explicitly in the command.
                </p>
                <button className="button" type="submit">Start and wait for readiness</button>
              </form>
            </section>
          )}

          {previewRuns.length > 1 && (
            <section className="panel">
              <span className="eyebrow">Preview History</span>
              <h2 style={{ marginTop: 8 }}>Preview history</h2>
              <div className="stack" style={{ marginTop: 16 }}>
                {previewRuns.slice(1).map((preview) => (
                  <div className="card" key={preview.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <strong><code>{preview.command}</code></strong>
                      <StatusBadge status={preview.status} />
                    </div>
                    <p className="muted">
                      Port {preview.port} · {preview.startedAt.toLocaleString("en-US", { timeZone: "Asia/Shanghai" })}
                    </p>
                    {preview.errorMessage && <pre>{preview.errorMessage}</pre>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {task.worktreePath && !runner && canOperate && (
            <section className="panel">
              <span className="eyebrow">AIO Sandbox</span>
              <h2 style={{ marginTop: 8 }}>Runner not started</h2>
              <p>Create a dedicated container for isolated command execution, code-server, and VNC.</p>
              <form action={startRunner}>
                <button className="button" type="submit">Start isolated Runner</button>
              </form>
            </section>
          )}

          {task.worktreePath && runner?.status === "running" && agentConnection && canOperate && !["submitted", "integrating", "merged", "rejected", "cancelled"].includes(task.status) && (
            <section className="panel">
              <span className="eyebrow">BYOK Agent Session</span>
              <h2 style={{ marginTop: 8 }}>Start {agentConnection.displayName}</h2>
              {agentConnection.credentialConfigured ? (
                <form className="form" action={runAgent}>
                  <label>
                    Agent instructions
                    <textarea name="prompt" required minLength={10} placeholder="Read the task, implement it, run tests, and create a Git Commit." />
                  </label>
                  <button className="button" type="submit">Start Agent with member-owned credentials</button>
                </form>
              ) : (
                <p>This member has not configured an API Key. Save credentials under <Link href="/#agents"><strong>Agents and credentials</strong></Link> first.</p>
              )}
            </section>
          )}

          {agentSessions.length > 0 && (
            <section className="panel">
              <span className="eyebrow">Agent History</span>
              <h2 style={{ marginTop: 8 }}>Task sessions</h2>
              <div className="stack" style={{ marginTop: 16 }}>
                {agentSessions.map((session) => (
                  <div className="card" key={session.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <strong>{session.agentDisplayName}</strong>
                      <StatusBadge status={session.status} />
                    </div>
                    <p><strong>Instructions:</strong> {session.prompt}</p>
                    {session.finalMessage && <pre>{session.finalMessage}</pre>}
                    {session.errorMessage && <pre>{session.errorMessage}</pre>}
                    <p className="muted">
                      {session.events?.length ?? 0} normalized events recorded
                      {session.providerSessionId ? ` · Agent session ${session.providerSessionId}` : ""}
                      {session.stopReason ? ` · ${session.stopReason}` : ""}
                    </p>
                    {(session.events?.length ?? 0) > 0 && (
                      <details>
                        <summary>View recent events</summary>
                        <div className="stack" style={{ marginTop: 12 }}>
                          {session.events?.slice(-10).map((event) => (
                            <pre key={event.sequenceNumber}>{JSON.stringify({
                              sequence: event.sequenceNumber,
                              type: event.eventType,
                              payload: event.payload,
                            }, null, 2)}</pre>
                          ))}
                        </div>
                      </details>
                    )}
                    {["starting", "running", "waiting"].includes(session.status) && canOperate && (
                      <form action={cancelAgentSessionAction.bind(null, session.id)}>
                        <input type="hidden" name="returnTo" value={`/tasks/${task.id}`} />
                        <button className="button secondary" type="submit">Stop this Agent session</button>
                      </form>
                    )}
                    {session.status === "completed" && session.providerSessionId && canOperate && (
                      <form className="form" action={runAgent}>
                        <input type="hidden" name="resumeSessionId" value={session.id} />
                        <label>
                          Continue this session
                          <textarea name="prompt" required minLength={10} placeholder="Add requirements, answer the Agent, or ask it to continue verification." />
                        </label>
                        <button className="button secondary" type="submit">Add instructions</button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {permissionRequests.length > 0 && (
            <section className="panel">
              <span className="eyebrow">Human Approval</span>
              <h2 style={{ marginTop: 8 }}>Agent permission requests</h2>
              <div className="stack" style={{ marginTop: 16 }}>
                {permissionRequests.map((permission) => {
                  const title = typeof permission.toolCall.title === "string"
                    ? permission.toolCall.title
                    : "Agent requested tool execution";
                  return (
                    <div className="card" key={permission.id}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                        <strong>{title}</strong>
                        <StatusBadge status={permission.status} />
                      </div>
                      <pre>{JSON.stringify(permission.toolCall, null, 2)}</pre>
                      {permission.status === "pending" && canOperate && (
                        <div className="button-row">
                          {permission.options.map((option, index) => {
                            const optionId = typeof option.optionId === "string" ? option.optionId : "";
                            const name = typeof option.name === "string" ? option.name : optionId;
                            if (!optionId) {
                              return null;
                            }
                            const resolvePermission = resolveAgentPermissionAction.bind(null, permission.id);
                            return (
                              <form action={resolvePermission} key={`${optionId}-${index}`}>
                                <input type="hidden" name="selectedOptionId" value={optionId} />
                                <input type="hidden" name="returnTo" value={`/tasks/${task.id}`} />
                                <button className="button secondary" type="submit">{name}</button>
                              </form>
                            );
                          })}
                          <form action={resolveAgentPermissionAction.bind(null, permission.id)}>
                            <input type="hidden" name="selectedOptionId" value="" />
                            <input type="hidden" name="returnTo" value={`/tasks/${task.id}`} />
                            <button className="button secondary" type="submit">Cancel request</button>
                          </form>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {workflowExecutions.length > 0 && (
            <section className="panel">
              <span className="eyebrow">Temporal History</span>
              <h2 style={{ marginTop: 8 }}>Durable workflows</h2>
              <div className="stack" style={{ marginTop: 16 }}>
                {workflowExecutions.map((execution) => (
                  <div className="card" key={execution.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <strong>{execution.workflowType}</strong>
                      <StatusBadge status={execution.status} />
                    </div>
                    <p className="muted"><code>{execution.workflowId}</code></p>
                    {execution.errorMessage && <pre>{execution.errorMessage}</pre>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="stack">
          {task.status === "draft" && canOperate && (
            <section className="panel">
              <h2>1. Create workspace</h2>
              <p>Create a task branch and isolated Worktree from the latest <code>{task.baseBranch}</code>.</p>
              <form action={provision}>
                <button className="button" type="submit">Create Worktree</button>
              </form>
            </section>
          )}

          {task.worktreePath && canOperate && ["workspace_ready", "active", "changes_requested"].includes(task.status) && (
            <section className="panel">
              <h2>2. Submit changes</h2>
              <p>The platform verifies a clean Worktree and a new Commit, then calculates the Diff and verification results.</p>
              <form className="form" action={submit}>
                <label>
                  Change summary
                  <textarea name="summary" minLength={10} required placeholder="Describe the implementation, key decisions, and impact" />
                </label>
                <label>
                  Known risks (one per line)
                  <textarea name="risks" placeholder="Example: Windows is not covered yet" />
                </label>
                <button className="button" type="submit">Submit for Admin review</button>
              </form>
            </section>
          )}

          {canOperate && ["draft", "workspace_ready", "active", "changes_requested"].includes(task.status) && (
            <section className="panel">
              <h2>Cancel task</h2>
              <p>Stop the active Agent, destroy the task Runner and preview, and release the Worktree. The task branch remains for audit.</p>
              <form action={cancelTask}>
                <button className="button danger" type="submit">Cancel task and release resources</button>
              </form>
            </section>
          )}

          <section className="panel">
            <h2>Security boundaries</h2>
            <ul className="muted">
              <li>Members and Agents do not write directly to main.</li>
              <li>Submitted changes must come from a real Git Commit.</li>
              <li>Admin integration approval still enters a temporary integration environment first.</li>
              <li>Updating the main branch requires final approval.</li>
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
