import { statusLabel } from "@/lib/domain";

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status.includes("failed") || status === "rejected"
      ? "danger"
      : status.includes("approval") || status === "submitted"
        ? "warning"
        : status === "merged" || status === "ready"
          ? "success"
          : "neutral";

  return <span className={`status status-${tone}`}>{statusLabel(status)}</span>;
}
