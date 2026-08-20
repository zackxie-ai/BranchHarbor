import {
  cancelAgentSessionAction,
  finalizeIntegrationAction,
  integrateAction,
  resolveAgentPermissionAction,
  reviewAction,
  runIntegrationAgentAction,
} from "@/app/actions";
import { StatusBadge } from "@/components/status-badge";
import { TaskLiveUpdates } from "@/components/task-live-updates";
import { requirePageUser } from "@/lib/auth";
import {
  getIntegrationRunner,
  getLatestIntegrationForChangeRequest,
  listAgentConnections,
  listChangeRequests,
  listIntegrationAgentPermissionRequests,
  listIntegrationAgentSessions,
  listWorkflowExecutions,
} from "@/lib/repositories";
import { getChangeRequestIntegrationQueueGate } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function ReviewsPage() {
  const actor = await requirePageUser();
  const isAdmin = actor.role === "admin";
  const [changeRequests, allAgentConnections] = await Promise.all([
    listChangeRequests(actor.id),
    listAgentConnections(actor.organizationId),
  ]);
  const adminAgents = allAgentConnections.filter(
    (connection) => connection.userId === actor.id && connection.credentialConfigured,
  );
  const integrationEntries = await Promise.all(
    changeRequests.map(async (changeRequest) => {
      const [integration, queueGate] = await Promise.all([
        getLatestIntegrationForChangeRequest(changeRequest.id),
        getChangeRequestIntegrationQueueGate(changeRequest.id, actor.id),
      ]);
      const runner = integration ? await getIntegrationRunner(integration.id) : null;
      const [changeRequestWorkflows, integrationWorkflows, sessions, permissions] = await Promise.all([
        listWorkflowExecutions("change_request", changeRequest.id),
        integration ? listWorkflowExecutions("integration", integration.id) : [],
        integration ? listIntegrationAgentSessions(integration.id) : [],
        integration ? listIntegrationAgentPermissionRequests(integration.id) : [],
      ]);
      return [
        changeRequest.id,
        {
          integration,
          runner,
          sessions,
          permissions,
          queueGate,
          workflows: [...changeRequestWorkflows, ...integrationWorkflows],
        },
      ] as const;
    }),
  );
  const integrations = new Map(integrationEntries);
  const liveSessions = integrationEntries.flatMap(([, state]) =>
    state.sessions.map((session) => ({
      id: session.id,
      status: session.status,
      lastSequence: session.events?.at(-1)?.sequenceNumber ?? 0,
    })),
  );
  const hasRunningWorkflow = integrationEntries.some(([, state]) =>
    state.workflows.some((workflow) => workflow.status === "running"),
  );

  return (
    <>
      <TaskLiveUpdates sessions={liveSessions} hasRunningWorkflow={hasRunningWorkflow} />
      <section className="section-head">
        <div>
          <span className="eyebrow">{isAdmin ? "Admin workspace" : "Shared progress"}</span>
          <h1 style={{ fontSize: 42 }}>Change review and integration</h1>
          <p>The first approval enters a temporary Integration Worktree. Only the second approval updates main.</p>
        </div>
      </section>

      <div className="stack">
        {changeRequests.length === 0 && <div className="empty">There are no change requests.</div>}
        {changeRequests.map((changeRequest) => {
          const integrationState = integrations.get(changeRequest.id);
          const integration = integrationState?.integration;
          const integrationRunner = integrationState?.runner;
          const integrationSessions = integrationState?.sessions ?? [];
          const integrationPermissions = integrationState?.permissions ?? [];
          const workflowExecutions = integrationState?.workflows ?? [];
          const queueGate = integrationState?.queueGate;
          const review = reviewAction.bind(null, changeRequest.id);
          const integrate = integrateAction.bind(null, changeRequest.id);
          const finalize = integration
            ? finalizeIntegrationAction.bind(null, integration.id)
            : undefined;
          const runIntegrationAgent = integration
            ? runIntegrationAgentAction.bind(null, integration.id)
            : undefined;

          return (
            <article className="panel" key={changeRequest.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 20, alignItems: "start" }}>
                <div>
                  <span className="eyebrow">{changeRequest.projectName}</span>
                  <h2 style={{ marginTop: 8 }}>{changeRequest.taskTitle}</h2>
                </div>
                <StatusBadge status={changeRequest.status} />
              </div>
              <p>{changeRequest.summary}</p>
              {queueGate?.queueId ? (
                <div className={queueGate.allowed ? "card" : "coordination-warning"} style={{ marginBottom: 16 }}>
                  <strong>
                    {queueGate.queued
                      ? `Position ${queueGate.position} in the Integration Queue`
                      : "Not in the current Integration Queue"}
                  </strong>
                  {queueGate.reason ? <span>{queueGate.reason}</span> : <span>This change is next in the queue.</span>}
                </div>
              ) : null}
              <div className="detail-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div>
                  <h3>Authoritative Git evidence</h3>
                  <pre>{changeRequest.diffStat || "No Diff statistics"}</pre>
                  <ul className="file-list">
                    {changeRequest.changedFiles.map((file) => (
                      <li key={`${file.status}-${file.path}`}>
                        <span className="file-status">{file.status}</span>
                        <code>
                          {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3>Verification results</h3>
                  {changeRequest.verificationResults.length ? changeRequest.verificationResults.map((result) => (
                    <div className="card" key={result.command} style={{ marginTop: 10 }}>
                      <StatusBadge status={result.exitCode === 0 ? "ready" : "failed"} />
                      <pre>{`$ ${result.command}\n${result.output || "(no output)"}`}</pre>
                    </div>
                  )) : <p className="muted">This task has no verification commands.</p>}
                  {changeRequest.risks.length > 0 && (
                    <>
                      <h3>Known risks</h3>
                      <ul>{changeRequest.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
                    </>
                  )}
                </div>
              </div>

              <div className="divider" />
              {isAdmin && changeRequest.status === "submitted" && (
                <form className="form" action={review}>
                  <label>
                    Admin comment
                    <textarea name="comment" placeholder="Approval rationale, requested changes, or rejection reason" />
                  </label>
                  <div className="button-row">
                    <button className="button" name="decision" value="approve_integration" type="submit">Approve for integration</button>
                    <button className="button warning" name="decision" value="request_changes" type="submit">Request changes</button>
                    <button className="button danger" name="decision" value="reject" type="submit">Reject</button>
                  </div>
                </form>
              )}

              {isAdmin && changeRequest.status === "approved_for_integration" && (
                <form action={integrate}>
                  <button className="button" type="submit" disabled={queueGate ? !queueGate.allowed : false}>
                    {queueGate && !queueGate.allowed
                      ? "Waiting for the Integration Queue"
                      : "Create Integration Worktree and attempt Git merge"}
                  </button>
                </form>
              )}

              {integration && (
                <div className="card" style={{ marginTop: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <h3>Integration Run</h3>
                    <StatusBadge status={integration.status} />
                  </div>
                  <p><code>{integration.worktreePath}</code></p>
                  {integrationRunner && (
                    <div className="button-row" style={{ marginBottom: 14 }}>
                      <StatusBadge status={integrationRunner.status} />
                      {isAdmin && integrationRunner.status === "running" && (
                        <>
                          <a className="button secondary" href={`/api/runners/${integrationRunner.id}/access?surface=code-server`} target="_blank" rel="noreferrer">Open Integration code-server</a>
                          <a className="button secondary" href={`/api/runners/${integrationRunner.id}/access?surface=vnc`} target="_blank" rel="noreferrer">Open VNC</a>
                        </>
                      )}
                    </div>
                  )}
                  <pre>{JSON.stringify(integration.report, null, 2)}</pre>
                  {integration.status === "needs_agent" && (
                    <>
                      <p>The Git merge encountered conflicts. The Admin can use their own Agent to resolve them inside this isolated Integration Worktree.</p>
                      {isAdmin && runIntegrationAgent && adminAgents.length > 0 && (
                        <form className="form" action={runIntegrationAgent}>
                          <label>
                            Admin Integration Agent
                            <select name="agentConnectionId" required defaultValue={adminAgents[0]?.id}>
                              {adminAgents.map((agent) => (
                                <option value={agent.id} key={agent.id}>
                                  {agent.displayName} · {agent.protocol}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Integration instructions
                            <textarea
                              name="prompt"
                              required
                              minLength={10}
                              defaultValue="Analyze both sides of the conflict, resolve every conflict, run verification, and create the integration Commit."
                            />
                          </label>
                          <button className="button" type="submit">Start Admin Integration Agent</button>
                        </form>
                      )}
                      {isAdmin && adminAgents.length === 0 && (
                        <p className="muted">The Admin has not configured an Agent and credentials. Complete the setup on the dashboard first.</p>
                      )}
                    </>
                  )}

                  {integrationSessions.length > 0 && (
                    <div className="stack" style={{ marginTop: 16 }}>
                      <h3>Integration Agent session</h3>
                      {integrationSessions.map((session) => (
                        <div className="card" key={session.id}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                            <strong>{session.agentDisplayName}</strong>
                            <StatusBadge status={session.status} />
                          </div>
                          <p><strong>Instructions:</strong> {session.prompt}</p>
                          {session.finalMessage && <pre>{session.finalMessage}</pre>}
                          {session.errorMessage && <pre>{session.errorMessage}</pre>}
                          <p className="muted">
                            {session.events?.length ?? 0} live events
                            {session.stopReason ? ` · ${session.stopReason}` : ""}
                          </p>
                          {(session.events?.length ?? 0) > 0 && (
                            <details>
                              <summary>View recent events</summary>
                              {session.events?.slice(-10).map((event) => (
                                <pre key={event.sequenceNumber}>{JSON.stringify({
                                  sequence: event.sequenceNumber,
                                  type: event.eventType,
                                  payload: event.payload,
                                }, null, 2)}</pre>
                              ))}
                            </details>
                          )}
                          {isAdmin && ["starting", "running", "waiting"].includes(session.status) && (
                            <form action={cancelAgentSessionAction.bind(null, session.id)}>
                              <input type="hidden" name="returnTo" value="/reviews" />
                              <button className="button secondary" type="submit">Stop Integration Agent</button>
                            </form>
                          )}
                          {isAdmin && integration.status === "needs_agent" && session.status === "completed" && session.providerSessionId && runIntegrationAgent && (
                            <form className="form" action={runIntegrationAgent}>
                              <input type="hidden" name="agentConnectionId" value={session.agentConnectionId ?? ""} />
                              <input type="hidden" name="resumeSessionId" value={session.id} />
                              <label>
                                Continue this integration session
                                <textarea name="prompt" required minLength={10} placeholder="Describe the remaining problem and ask the Agent to continue and Commit." />
                              </label>
                              <button className="button secondary" type="submit">Add integration instructions</button>
                            </form>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {integrationPermissions.some((permission) => permission.status === "pending") && (
                    <div className="stack" style={{ marginTop: 16 }}>
                      <h3>Waiting for Admin permission decision</h3>
                      {integrationPermissions
                        .filter((permission) => permission.status === "pending")
                        .map((permission) => (
                          <div className="card" key={permission.id}>
                            <pre>{JSON.stringify(permission.toolCall, null, 2)}</pre>
                            <div className="button-row">
                              {permission.options.map((option, index) => {
                                const optionId = typeof option.optionId === "string" ? option.optionId : "";
                                const name = typeof option.name === "string" ? option.name : optionId;
                                if (!optionId) {
                                  return null;
                                }
                                return (
                                  <form action={resolveAgentPermissionAction.bind(null, permission.id)} key={`${optionId}-${index}`}>
                                    <input type="hidden" name="selectedOptionId" value={optionId} />
                                    <input type="hidden" name="returnTo" value="/reviews" />
                                    <button className="button secondary" type="submit">{name}</button>
                                  </form>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                  {isAdmin && integration.status === "awaiting_final_approval" && finalize && (
                    <form className="form" action={finalize}>
                      <label>
                        Final approval comment
                        <textarea name="comment" placeholder="Confirm that the integration report and verification results are acceptable" />
                      </label>
                      <button className="button" type="submit">Grant final approval and update main</button>
                    </form>
                  )}
                </div>
              )}

              {workflowExecutions.length > 0 && (
                <div className="card" style={{ marginTop: 16 }}>
                  <h3>Temporal execution history</h3>
                  <div className="stack" style={{ marginTop: 12 }}>
                    {workflowExecutions.map((execution) => (
                      <div key={execution.id}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                          <code>{execution.workflowType}</code>
                          <StatusBadge status={execution.status} />
                        </div>
                        {execution.errorMessage && <pre>{execution.errorMessage}</pre>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}
