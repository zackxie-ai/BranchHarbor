"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface PreviewState {
  id: string;
  command: string;
  port: number;
  status: "starting" | "running" | "completed" | "stopped" | "failed";
  previewUrl: string;
  output: string;
  exitCode: number | null;
  errorMessage: string | null;
}

const statusLabels: Record<PreviewState["status"], string> = {
  starting: "Starting",
  running: "Running",
  completed: "Completed",
  stopped: "Stopped",
  failed: "Failed to start",
};

function statusTone(status: PreviewState["status"]): string {
  if (status === "running") return "status-success";
  if (status === "starting") return "status-warning";
  if (status === "failed") return "status-danger";
  return "status-neutral";
}

export function TaskPreviewLive({
  initialPreview,
  stopAction,
}: {
  initialPreview: PreviewState;
  stopAction?: () => Promise<void>;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState(initialPreview);

  useEffect(() => {
    if (!["starting", "running"].includes(preview.status)) {
      return;
    }
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/task-previews/${preview.id}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as { preview: PreviewState };
        if (!disposed) {
          setPreview(body.preview);
          if (!["starting", "running"].includes(body.preview.status)) {
            router.refresh();
          }
        }
      } catch {
        // A later poll can recover from a transient network failure.
      }
    };
    const timer = setInterval(refresh, 2_000);
    void refresh();
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [preview.id, preview.status, router]);

  const isActive = preview.status === "starting" || preview.status === "running";
  return (
    <section className="panel preview-panel" id="preview">
      <div className="preview-head">
        <div>
          <span className="eyebrow">Live Application Preview</span>
          <h2 style={{ marginTop: 8 }}>Task application preview</h2>
        </div>
        <span className={`status ${statusTone(preview.status)}`}>
          {statusLabels[preview.status]}
        </span>
      </div>
      <dl className="definition compact-definition">
        <dt>Command</dt><dd><code>{preview.command}</code></dd>
        <dt>Port</dt><dd><code>{preview.port}</code></dd>
        {preview.exitCode !== null && <><dt>Exit code</dt><dd><code>{preview.exitCode}</code></dd></>}
      </dl>
      <div className="button-row">
        {preview.status === "running" && (
          <a className="button" href={preview.previewUrl} target="_blank" rel="noreferrer">
            Open in new window
          </a>
        )}
        {isActive && stopAction && (
          <form action={stopAction}>
            <button className="button danger" type="submit">Stop preview</button>
          </form>
        )}
      </div>
      {preview.status === "running" && (
        <iframe
          className="preview-frame"
          src={preview.previewUrl}
          title="Task application preview"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        />
      )}
      {preview.errorMessage && <div className="auth-error" role="alert">{preview.errorMessage}</div>}
      <div className="preview-log-head">
        <strong>Runtime log</strong>
        {isActive && <span className="muted">Refreshes every 2 seconds</span>}
      </div>
      <pre className="preview-log">{preview.output || "Waiting for application output..."}</pre>
    </section>
  );
}
