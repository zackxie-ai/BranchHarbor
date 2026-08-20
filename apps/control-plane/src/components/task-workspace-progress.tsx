"use client";

import { useEffect, useState } from "react";

import type {
  ChangedFile,
  TaskWorkspaceBackup,
  TaskWorkspaceProgress,
  TaskWorkspaceSnapshot,
} from "@/lib/types";

function FileChanges({ title, files }: { title: string; files: ChangedFile[] }) {
  return (
    <div>
      <strong>{title}</strong>
      {files.length > 0 ? (
        <ul className="file-list compact-file-list">
          {files.map((file) => (
            <li key={`${file.status}-${file.path}`}>
              <span className="file-status">{file.status}</span>
              <code>
                {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
              </code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None</p>
      )}
    </div>
  );
}

function progressTone(progress: TaskWorkspaceProgress | null): string {
  if (!progress) return "status-neutral";
  if (
    progress.overlappingFiles.length > 0 ||
    progress.structuralConflicts.some((conflict) => conflict.severity === "danger")
  ) return "status-danger";
  if (progress.structuralConflicts.length > 0 || progress.mainAdvanced) return "status-warning";
  if (progress.workingTreeClean) return "status-success";
  return "status-neutral";
}

function progressLabel(progress: TaskWorkspaceProgress | null): string {
  if (!progress) return "Waiting for status";
  if (progress.overlappingFiles.length > 0) return "Actual overlap detected";
  if (progress.structuralConflicts.some((conflict) => conflict.severity === "danger")) {
    return "Structural conflict detected";
  }
  if (progress.structuralConflicts.length > 0) return "Related risk detected";
  if (progress.mainAdvanced) return "main has advanced";
  if (progress.workingTreeClean) return "Workspace clean";
  return "Changes in progress";
}

function backupTone(backup: TaskWorkspaceBackup | null): string {
  if (!backup) return "status-neutral";
  if (backup.status === "failed") return "status-danger";
  if (backup.status === "restored") return "status-warning";
  return "status-success";
}

function backupLabel(backup: TaskWorkspaceBackup | null): string {
  if (!backup) return "Waiting for remote backup";
  if (backup.status === "failed") return "Remote backup failed";
  if (backup.status === "restored") return "Restored from remote";
  if (backup.checkpointCommit) return "Commit and WIP saved";
  return "Remote branch synchronized";
}

export function TaskWorkspaceProgressPanel({
  taskId,
  initialProgress,
  initialSnapshots,
  initialBackup,
  pollingEnabled,
}: {
  taskId: string;
  initialProgress: TaskWorkspaceProgress | null;
  initialSnapshots: TaskWorkspaceSnapshot[];
  initialBackup: TaskWorkspaceBackup | null;
  pollingEnabled: boolean;
}) {
  const [progress, setProgress] = useState(initialProgress);
  const [snapshots, setSnapshots] = useState(initialSnapshots);
  const [backup, setBackup] = useState(initialBackup);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pollingEnabled) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/tasks/${taskId}/workspace-status`, {
          cache: "no-store",
        });
        const body = (await response.json()) as {
          progress?: TaskWorkspaceProgress;
          snapshots?: TaskWorkspaceSnapshot[];
          backup?: TaskWorkspaceBackup | null;
          error?: string;
        };
        if (disposed) return;
        if (!response.ok || !body.progress) {
          setError(body.error ?? "Unable to read workspace status");
          return;
        }
        setProgress(body.progress);
        if (body.snapshots) setSnapshots(body.snapshots);
        if (body.backup !== undefined) setBackup(body.backup);
        setError(null);
      } catch {
        if (!disposed) setError("Workspace status refresh failed. Retrying automatically.");
      }
    };
    const timer = setInterval(refresh, 10_000);
    void refresh();
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [pollingEnabled, taskId]);

  return (
    <section className="panel workspace-progress-panel">
      <div className="preview-head">
        <div>
          <span className="eyebrow">Live Git Progress</span>
          <h2 style={{ marginTop: 8 }}>Live workspace progress</h2>
        </div>
        <span className={`status ${progressTone(progress)}`}>{progressLabel(progress)}</span>
      </div>
      {error ? <div className="auth-error" role="alert">{error}</div> : null}
      <div className={`coordination-warning ${backup?.status === "failed" ? "coordination-danger" : ""}`}>
        <div className="preview-head">
          <strong>Remote project backup</strong>
          <span className={`status ${backupTone(backup)}`}>{backupLabel(backup)}</span>
        </div>
        {backup ? (
          <span>
            Task branch <code>{backup.branchName}</code> is saved in the canonical Git repository
            {backup.remoteHeadCommit ? `, remote HEAD ${backup.remoteHeadCommit.slice(0, 12)}` : ""}
            {backup.checkpointCommit ? `, uncommitted-change checkpoint ${backup.checkpointCommit.slice(0, 12)}` : ""}.
            {backup.errorMessage ? ` Error: ${backup.errorMessage}` : ""}
          </span>
        ) : (
          <span>After workspace creation, the platform automatically saves the task branch and uncommitted-change checkpoints.</span>
        )}
        {backup?.lastRestoredAt ? (
          <span>
            Last restored from remote: {new Date(backup.lastRestoredAt).toLocaleString("en-US", { hour12: false })}
          </span>
        ) : null}
      </div>
      {progress ? (
        <>
          <div className="metric-row workspace-progress-metrics">
            <div className="metric"><strong>{progress.committedFiles.length}</strong><span>Committed files</span></div>
            <div className="metric"><strong>{progress.uncommittedFiles.length}</strong><span>Uncommitted files</span></div>
            <div className="metric"><strong>{progress.mainCommitsSinceBase}</strong><span>New main Commits</span></div>
            <div className="metric"><strong>{progress.overlappingFiles.length}</strong><span>Overlapping files</span></div>
            <div className="metric"><strong>{progress.structuralConflicts.length}</strong><span>Structural risks</span></div>
          </div>
          {progress.mainAdvanced ? (
            <div className={`coordination-warning ${progress.overlappingFiles.length > 0 ? "coordination-danger" : ""}`}>
              <strong>main advanced by {progress.mainCommitsSinceBase} Commits after task creation</strong>
              <span>
                {progress.overlappingFiles.length > 0
                  ? `Both sides changed: ${progress.overlappingFiles.join(", ")}`
                  : `main changed ${progress.mainChangedFiles.length} files with no direct overlap with task files.`}
              </span>
            </div>
          ) : null}
          {progress.structuralConflicts.length > 0 ? (
            <div className={`coordination-warning ${progress.structuralConflicts.some((conflict) => conflict.severity === "danger") ? "coordination-danger" : ""}`}>
              <strong>Rename, directory, or cross-file relationship risks detected</strong>
              <ul>
                {progress.structuralConflicts.map((conflict) => (
                  <li key={`${conflict.kind}-${conflict.taskPath}-${conflict.mainPath}`}>
                    <code>{conflict.kind}</code> · {conflict.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="grid two workspace-file-grid">
            <FileChanges title="Committed task changes" files={progress.committedFiles} />
            <FileChanges title="Uncommitted task changes" files={progress.uncommittedFiles} />
            <FileChanges title="main changes after task creation" files={progress.mainChangedFiles} />
            <div>
              <strong>Git pointers</strong>
              <dl className="definition workspace-commit-definition">
                <dt>Task HEAD</dt><dd><code>{progress.headCommit.slice(0, 12)}</code></dd>
                <dt>Latest main</dt><dd><code>{progress.mainCommit.slice(0, 12)}</code></dd>
                <dt>Base Commit</dt><dd><code>{progress.baseCommit.slice(0, 12)}</code></dd>
              </dl>
            </div>
          </div>
          <p className="muted workspace-progress-updated">
            Last checked: {new Date(progress.checkedAt).toLocaleString("en-US", { hour12: false })}
            {pollingEnabled ? " · Refreshes every 10 seconds" : " · Live polling has stopped"}
          </p>
        </>
      ) : (
        <p className="muted">
          {pollingEnabled ? "Reading authoritative Git status..." : "This task is no longer checked live. Saved history remains available."}
        </p>
      )}
      <div className="divider" />
      <div>
        <strong>Git progress history</strong>
        <p className="muted">Snapshots are recorded only when authoritative state changes, not on every poll.</p>
      </div>
      {snapshots.length > 0 ? (
        <div className="workspace-history-list">
          {snapshots.slice(0, 12).map((snapshot) => (
            <div className="workspace-history-item" key={snapshot.id}>
              <div>
                <strong><code>{snapshot.headCommit.slice(0, 12)}</code></strong>
                <span>
                  Committed {snapshot.committedFiles.length} · uncommitted {snapshot.uncommittedFiles.length}
                  {snapshot.mainAdvanced ? ` · main +${snapshot.mainCommitsSinceBase}` : ""}
                  {snapshot.overlappingFiles.length > 0
                    ? ` · overlap ${snapshot.overlappingFiles.length}`
                    : ""}
                  {snapshot.structuralConflicts.length > 0
                    ? ` · structural risks ${snapshot.structuralConflicts.length}`
                    : ""}
                </span>
              </div>
              <time dateTime={snapshot.createdAt}>
                {new Date(snapshot.createdAt).toLocaleString("en-US", { hour12: false })}
              </time>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No history snapshots recorded yet.</p>
      )}
    </section>
  );
}
