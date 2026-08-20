import { runProjectValidationAction } from "@/app/actions";
import type { ProjectIntegrationQueue } from "@/lib/integration-queue";
import type { ProjectValidationRun } from "@/lib/project-validation";

function statusTone(status: ProjectValidationRun["status"]): string {
  if (status === "passed") return "status-success";
  if (status === "failed") return "status-danger";
  return "status-warning";
}

export function ProjectValidationPanel({
  projectId,
  queues,
  runs,
  isAdmin,
}: {
  projectId: string;
  queues: ProjectIntegrationQueue[];
  runs: ProjectValidationRun[];
  isAdmin: boolean;
}) {
  const eligibleQueues = queues.filter(
    (queue) => queue.status === "completed" && queue.items.some((item) => item.changeRequestStatus === "merged"),
  );
  const runValidation = runProjectValidationAction.bind(null, projectId);

  return (
    <section className="panel merge-plan-panel" id="joint-validation">
      <div className="preview-head">
        <div>
          <span className="eyebrow">Cross-task Verification</span>
          <h2 style={{ marginTop: 8 }}>Cross-task verification</h2>
        </div>
        <span className={`status ${runs[0] ? statusTone(runs[0].status) : "status-neutral"}`}>
          {runs[0]?.status ?? "Not run"}
        </span>
      </div>

      {isAdmin && eligibleQueues.length > 0 ? (
        <form className="form" action={runValidation}>
          <label>
            Completed Integration Queue
            <select name="integrationQueueId" required defaultValue={eligibleQueues[0]?.id}>
              {eligibleQueues.map((queue) => {
                const mergedCount = queue.items.filter((item) => item.changeRequestStatus === "merged").length;
                return (
                  <option value={queue.id} key={queue.id}>
                    {new Date(queue.completedAt ?? queue.updatedAt).toLocaleString("en-US", { hour12: false })} · {mergedCount} merged
                  </option>
                );
              })}
            </select>
          </label>
          <label>
            Additional project-level commands
            <textarea name="commands" placeholder={"pnpm lint\npnpm test\npnpm build"} />
          </label>
          <button className="button" type="submit">Run cross-task verification</button>
        </form>
      ) : null}

      {eligibleQueues.length === 0 ? (
        <div className="empty">Complete an Integration Queue containing at least one merged task before running verification.</div>
      ) : null}

      {runs.length > 0 ? (
        <div className="merge-plan-list">
          {runs.slice(0, 10).map((run, index) => (
            <div className="merge-plan-item" key={run.id}>
              <div className="merge-plan-position">{runs.length - index}</div>
              <div className="merge-plan-content">
                <div className="notification-head">
                  <strong>{new Date(run.createdAt).toLocaleString("en-US", { hour12: false })}</strong>
                  <span className={`status ${statusTone(run.status)}`}>{run.status}</span>
                </div>
                <p className="muted">
                  main <code>{run.mainCommit?.slice(0, 12) ?? "pending"}</code> · {run.commands.length} commands
                </p>
                {run.errorMessage ? <div className="auth-error" role="alert">{run.errorMessage}</div> : null}
                {run.results.map((result) => (
                  <details key={result.command}>
                    <summary>
                      <code>{result.command}</code> · exit {result.exitCode} · {result.durationMs}ms
                    </summary>
                    <pre>{result.output || "(no output)"}</pre>
                  </details>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No cross-task verification runs yet.</p>
      )}
    </section>
  );
}
