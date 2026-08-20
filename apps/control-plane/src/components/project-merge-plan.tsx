import Link from "next/link";

import {
  cancelProjectIntegrationQueueAction,
  cancelAgentSessionAction,
  replaceProjectIntegrationQueueAction,
  resolveAgentPermissionAction,
  runProjectMergePlanAgentAction,
} from "@/app/actions";
import type { ProjectIntegrationQueue } from "@/lib/integration-queue";
import type {
  MergePlanReadiness,
  MergePlanRiskLevel,
  ProjectMergePlan,
  ProjectMergePlanAgentRun,
} from "@/lib/merge-planning";
import type {
  AgentConnection,
  AgentPermissionRequest,
  AgentSession,
} from "@/lib/types";

function readinessLabel(readiness: MergePlanReadiness): string {
  if (readiness === "integrating") return "Integrating";
  if (readiness === "ready") return "Ready";
  if (readiness === "changes_requested") return "Changes requested";
  if (readiness === "blocked_by_dependency") return "Blocked by dependency";
  return "Not submitted";
}

function readinessTone(readiness: MergePlanReadiness): string {
  if (readiness === "ready") return "status-success";
  if (readiness === "integrating") return "status-warning";
  if (readiness === "blocked_by_dependency") return "status-danger";
  return "status-neutral";
}

function riskLabel(riskLevel: MergePlanRiskLevel): string {
  if (riskLevel === "high") return "High risk";
  if (riskLevel === "medium") return "Medium risk";
  return "Low risk";
}

function riskTone(riskLevel: MergePlanRiskLevel): string {
  if (riskLevel === "high") return "status-danger";
  if (riskLevel === "medium") return "status-warning";
  return "status-success";
}

export function ProjectMergePlanPanel({
  projectId,
  mergePlan,
  isAdmin,
  adminAgents,
  latestAgentRun,
  agentSessions,
  permissionRequests,
  integrationQueue,
}: {
  projectId: string;
  mergePlan: ProjectMergePlan;
  isAdmin: boolean;
  adminAgents: AgentConnection[];
  latestAgentRun: ProjectMergePlanAgentRun | null;
  agentSessions: AgentSession[];
  permissionRequests: AgentPermissionRequest[];
  integrationQueue: ProjectIntegrationQueue | null;
}) {
  const runSemanticAnalysis = runProjectMergePlanAgentAction.bind(null, projectId);
  const replaceIntegrationQueue = replaceProjectIntegrationQueueAction.bind(null, projectId);
  const cancelIntegrationQueue = cancelProjectIntegrationQueueAction.bind(null, projectId);
  const activeSession = agentSessions.find((session) =>
    ["starting", "running", "waiting"].includes(session.status),
  );
  const activeRun = latestAgentRun && ["starting", "running"].includes(latestAgentRun.status);
  const titleByTaskId = new Map([
    ...mergePlan.items.map((item) => [item.taskId, item.title] as const),
    ...(latestAgentRun?.baselinePlan.items ?? []).map((item) => [item.taskId, item.title] as const),
  ]);
  const rationaleByTaskId = new Map(
    latestAgentRun?.suggestion?.orderRationale.map((item) => [item.taskId, item.reason]) ?? [],
  );
  return (
    <section className="panel merge-plan-panel" id="merge-plan">
      <div className="preview-head">
        <div>
          <span className="eyebrow">Integration Planning</span>
          <h2 style={{ marginTop: 8 }}>Recommended integration order</h2>
          <p>
            The platform preserves explicit dependency order, then considers submission readiness, downstream dependents, scope overlap, renames, directory moves, and cross-file import risks.
            {isAdmin ? " The Admin still determines the final order through review and approval." : " This is a read-only team view."}
          </p>
        </div>
        <span className={`status ${mergePlan.readyTaskIds.length > 0 ? "status-success" : "status-neutral"}`}>
          {mergePlan.readyTaskIds.length} ready
        </span>
      </div>
      {mergePlan.hasDependencyCycle ? (
        <div className="auth-error" role="alert">A dependency cycle was detected. Fix task dependencies before integration.</div>
      ) : null}
      {mergePlan.items.length > 0 ? (
        <div className="merge-plan-list">
          {mergePlan.items.map((item) => (
            <div className="merge-plan-item" key={item.taskId}>
              <div className="merge-plan-position">{item.position}</div>
              <div className="merge-plan-content">
                <div className="notification-head">
                  <Link href={`/tasks/${item.taskId}`}><strong>{item.title}</strong></Link>
                  <div className="merge-plan-badges">
                    <span className={`status ${readinessTone(item.readiness)}`}>
                      {readinessLabel(item.readiness)}
                    </span>
                    <span className={`status ${riskTone(item.riskLevel)}`}>
                      {riskLabel(item.riskLevel)}
                    </span>
                  </div>
                </div>
                <p className="muted">
                  {item.assignedUserName ?? "Unnamed member"} · {item.status}
                  {item.directDependentCount > 0 ? ` · ${item.directDependentCount} direct dependents` : ""}
                </p>
                <ul className="merge-plan-reasons">
                  {item.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">No active tasks currently require integration planning.</div>
      )}
      <small className="muted">
        Rule version: {mergePlan.method} · Generated: {new Date(mergePlan.generatedAt).toLocaleString("en-US", { hour12: false })}
      </small>

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="preview-head">
          <div>
            <span className="eyebrow">Admin Semantic Review</span>
            <h3 style={{ marginTop: 8 }}>AI semantic integration recommendation</h3>
            <p>
              The Admin can use their own Agent in a disposable read-only Runner to inspect code, task descriptions, and Change Requests.
              The platform validates task completeness and dependency order. Recommendations cannot change the queue automatically or write to main.
            </p>
          </div>
          {latestAgentRun ? (
            <span className={`status ${
              latestAgentRun.status === "completed"
                ? "status-success"
                : latestAgentRun.status === "failed" || latestAgentRun.status === "invalid"
                  ? "status-danger"
                  : "status-warning"
            }`}>
              {latestAgentRun.status}
            </span>
          ) : null}
        </div>

        {isAdmin ? (
          adminAgents.length > 0 ? (
            <form className="form" action={runSemanticAnalysis}>
              <label>
                Admin Agent
                <select name="agentConnectionId" required defaultValue={adminAgents[0]?.id}>
                  {adminAgents.map((agent) => (
                    <option value={agent.id} key={agent.id}>
                      {agent.displayName} · {agent.provider}{agent.model ? ` · ${agent.model}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Analysis focus
                <textarea
                  name="instruction"
                  required
                  minLength={10}
                  defaultValue="Inspect hidden interface, data-structure, database-migration, and behavioral dependencies between tasks, then recommend a safe integration order."
                />
              </label>
              <button className="button" type="submit" disabled={Boolean(activeRun)}>
                {activeRun ? "Semantic analysis running" : "Run read-only semantic analysis"}
              </button>
            </form>
          ) : (
            <p className="muted">Configure an available Agent and credential for the current Admin first.</p>
          )
        ) : (
          <p className="muted">Only an Admin can start semantic analysis. Team members can view validated results.</p>
        )}

        {isAdmin && activeSession ? (
          <form action={cancelAgentSessionAction.bind(null, activeSession.id)}>
            <input type="hidden" name="returnTo" value={`/projects/${projectId}#merge-plan`} />
            <button className="button secondary" type="submit">Stop semantic analysis</button>
          </form>
        ) : null}

        {isAdmin && permissionRequests.some((permission) => permission.status === "pending") ? (
          <div className="stack" style={{ marginTop: 16 }}>
            <h3>Waiting for Admin permission decision</h3>
            {permissionRequests
              .filter((permission) => permission.status === "pending")
              .map((permission) => (
                <div className="card" key={permission.id}>
                  <pre>{JSON.stringify(permission.toolCall, null, 2)}</pre>
                  <div className="button-row">
                    {permission.options.map((option, index) => {
                      const optionId = typeof option.optionId === "string" ? option.optionId : "";
                      const name = typeof option.name === "string" ? option.name : optionId;
                      if (!optionId) return null;
                      return (
                        <form
                          action={resolveAgentPermissionAction.bind(null, permission.id)}
                          key={`${optionId}-${index}`}
                        >
                          <input type="hidden" name="selectedOptionId" value={optionId} />
                          <input type="hidden" name="returnTo" value={`/projects/${projectId}#merge-plan`} />
                          <button className="button secondary" type="submit">{name}</button>
                        </form>
                      );
                    })}
                    <form action={resolveAgentPermissionAction.bind(null, permission.id)}>
                      <input type="hidden" name="selectedOptionId" value="" />
                      <input type="hidden" name="returnTo" value={`/projects/${projectId}#merge-plan`} />
                      <button className="button danger" type="submit">Reject</button>
                    </form>
                  </div>
                </div>
              ))}
          </div>
        ) : null}

        {latestAgentRun?.suggestion ? (
          <div className="stack" style={{ marginTop: 16 }}>
            <div className="card">
              <strong>Agent summary</strong>
              <p>{latestAgentRun.suggestion.summary}</p>
              <p className="muted">
                {latestAgentRun.suggestion.differsFromBaseline
                  ? "The Agent recommends changing the rule-based order. The Admin decides whether to adopt it."
                  : "The Agent recommends keeping the current rule-based order."}
              </p>
            </div>
            <div className="merge-plan-list">
              {latestAgentRun.suggestion.recommendedTaskIds.map((taskId, index) => (
                <div className="merge-plan-item" key={taskId}>
                  <div className="merge-plan-position">{index + 1}</div>
                  <div className="merge-plan-content">
                    <Link href={`/tasks/${taskId}`}><strong>{titleByTaskId.get(taskId) ?? taskId}</strong></Link>
                    <p>{rationaleByTaskId.get(taskId) ?? "The Agent did not provide an item-specific rationale"}</p>
                  </div>
                </div>
              ))}
            </div>
            {latestAgentRun.suggestion.semanticConflicts.map((conflict, index) => (
              <div className="coordination-warning" key={`${conflict.taskIds.join("-")}-${index}`}>
                <strong>{conflict.severity === "danger" ? "High-risk semantic conflict" : "Semantic relationship"}: {conflict.summary}</strong>
                <span>
                  Tasks: {conflict.taskIds.map((taskId) => titleByTaskId.get(taskId) ?? taskId).join(", ")}
                </span>
                {conflict.evidence.map((evidence) => <span key={evidence}>{evidence}</span>)}
                <span>Recommendation: {conflict.recommendation}</span>
              </div>
            ))}
            {latestAgentRun.suggestion.uncertainties.length > 0 ? (
              <div className="card">
                <strong>Remaining uncertainties</strong>
                <ul>{latestAgentRun.suggestion.uncertainties.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {latestAgentRun?.errorMessage ? (
          <div className="auth-error" role="alert">{latestAgentRun.errorMessage}</div>
        ) : null}
        {latestAgentRun ? (
          <small className="muted">
            Last run: {latestAgentRun.agentDisplayName ?? latestAgentRun.agentConnectionId} · {new Date(latestAgentRun.createdAt).toLocaleString("en-US", { hour12: false })}
          </small>
        ) : null}
      </div>

      <div className="panel" id="integration-queue" style={{ marginTop: 20 }}>
        <div className="preview-head">
          <div>
            <span className="eyebrow">Admin Decision</span>
            <h3 style={{ marginTop: 8 }}>Integration Queue</h3>
            <p>
              The Admin-selected order becomes an enforced integration gate. The next Integration Worktree can be created only after the preceding item is merged, rejected, or cancelled.
            </p>
          </div>
          {integrationQueue ? (
            <span className="status status-warning">{integrationQueue.items.length} queued</span>
          ) : (
            <span className="status status-neutral">Inactive</span>
          )}
        </div>

        {integrationQueue ? (
          <div className="stack">
            <div className="merge-plan-list">
              {integrationQueue.items.map((item) => (
                <div className="merge-plan-item" key={item.taskId}>
                  <div className="merge-plan-position">{item.position}</div>
                  <div className="merge-plan-content">
                    <div className="notification-head">
                      <Link href={`/tasks/${item.taskId}`}><strong>{item.taskTitle}</strong></Link>
                      <span className={`status ${["merged", "rejected", "cancelled"].includes(item.changeRequestStatus) ? "status-neutral" : item.position === 1 ? "status-success" : "status-warning"}`}>
                        {item.changeRequestStatus}
                      </span>
                    </div>
                    <p className="muted"><code>{item.headCommit.slice(0, 12)}</code></p>
                  </div>
                </div>
              ))}
            </div>
            <small className="muted">
              Source: {integrationQueue.source === "semantic" ? "AI semantic recommendation" : "Deterministic rules"} · Created: {new Date(integrationQueue.createdAt).toLocaleString("en-US", { hour12: false })}
            </small>
            {isAdmin ? (
              <form className="form" action={cancelIntegrationQueue}>
                <label>
                  Cancellation or replacement reason
                  <textarea name="reason" required minLength={10} placeholder="Explain why this integration order should be cancelled. A new queue can be created afterward." />
                </label>
                <button className="button danger" type="submit">Cancel current Integration Queue</button>
              </form>
            ) : null}
          </div>
        ) : (
          <p className="muted">No active queue. Existing dependency gates remain enforced.</p>
        )}

        {isAdmin && mergePlan.readyTaskIds.length > 0 ? (
          <form className="form" action={replaceIntegrationQueue} style={{ marginTop: 18 }}>
            <label>
              Order source
              <select name="source" defaultValue="deterministic">
                <option value="deterministic">Deterministic rule order</option>
                <option
                  value="semantic"
                  disabled={latestAgentRun?.status !== "completed" || !latestAgentRun.suggestion}
                >
                  Latest validated AI semantic order
                </option>
              </select>
            </label>
            <fieldset>
              <legend>Select tasks to integrate in this queue</legend>
              <div className="stack">
                {mergePlan.items
                  .filter((item) => mergePlan.readyTaskIds.includes(item.taskId))
                  .map((item) => (
                    <label key={item.taskId} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <input type="checkbox" name="selectedTaskIds" value={item.taskId} defaultChecked />
                      <span>{item.position}. {item.title} · {riskLabel(item.riskLevel)}</span>
                    </label>
                  ))}
              </div>
            </fieldset>
            <button className="button" type="submit">
              {integrationQueue ? "Replace and activate new queue" : "Create and activate Integration Queue"}
            </button>
          </form>
        ) : null}
      </div>
      </section>
  );
}
