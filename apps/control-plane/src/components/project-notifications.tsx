"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { ProjectNotification } from "@/lib/types";

function notificationTone(severity: ProjectNotification["severity"]): string {
  if (severity === "danger") return "status-danger";
  if (severity === "warning") return "status-warning";
  return "status-neutral";
}

function notificationLabel(severity: ProjectNotification["severity"]): string {
  if (severity === "danger") return "High risk";
  if (severity === "warning") return "Attention";
  return "Progress";
}

export function ProjectNotifications({
  projectId,
  initialNotifications,
}: {
  projectId: string;
  initialNotifications: ProjectNotification[];
}) {
  const [notifications, setNotifications] = useState(initialNotifications);
  const [error, setError] = useState<string | null>(null);
  const [markingTarget, setMarkingTarget] = useState<string | null>(null);
  const unreadCount = notifications.filter((notification) => !notification.read).length;

  const markRead = async (notificationIds: string[], target: string) => {
    setMarkingTarget(target);
    try {
      const response = await fetch(`/api/projects/${projectId}/notifications`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notificationIds }),
      });
      const body = (await response.json()) as {
        notifications?: ProjectNotification[];
        error?: string;
      };
      if (!response.ok || !body.notifications) {
        setError(body.error ?? "Unable to update project notifications");
        return;
      }
      setNotifications(body.notifications);
      setError(null);
    } catch {
      setError("Project notification update failed. Please try again later.");
    } finally {
      setMarkingTarget(null);
    }
  };

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/notifications`, {
          cache: "no-store",
        });
        const body = (await response.json()) as {
          notifications?: ProjectNotification[];
          error?: string;
        };
        if (disposed) return;
        if (!response.ok || !body.notifications) {
          setError(body.error ?? "Unable to refresh project notifications");
          return;
        }
        setNotifications(body.notifications);
        setError(null);
      } catch {
        if (!disposed) setError("Project notification refresh failed. Retrying automatically.");
      }
    };
    const timer = setInterval(refresh, 15_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [projectId]);

  return (
    <section className="panel notification-panel">
      <div className="preview-head">
        <div>
          <span className="eyebrow">Shared Progress Alerts</span>
          <h2 style={{ marginTop: 8 }}>Project notifications</h2>
          <p>Tracks new Commits, main drift, and actual file overlap. Refreshes every 15 seconds.</p>
        </div>
        <div className="notification-summary">
          <span className={`status ${unreadCount > 0 ? "status-warning" : "status-neutral"}`}>
            {unreadCount} unread · {notifications.length} total
          </span>
          {unreadCount > 0 ? (
            <button
              className="notification-read-button"
              disabled={markingTarget !== null}
              onClick={() => void markRead([], "all")}
              type="button"
            >
              {markingTarget === "all" ? "Updating..." : "Mark all as read"}
            </button>
          ) : null}
        </div>
      </div>
      {error ? <div className="auth-error" role="alert">{error}</div> : null}
      {notifications.length > 0 ? (
        <div className="notification-list">
          {notifications.slice(0, 12).map((notification) => {
            const content = (
              <>
                <div className="notification-head">
                  <strong>{notification.title}</strong>
                  <span className={`status ${notificationTone(notification.severity)}`}>
                    {notificationLabel(notification.severity)}
                  </span>
                </div>
                <p>{notification.message}</p>
                <small>
                  {notification.taskTitle ? `${notification.taskTitle} · ` : ""}
                  {new Date(notification.createdAt).toLocaleString("en-US", { hour12: false })}
                </small>
              </>
            );
            return (
              <div
                className={`notification-item${notification.read ? "" : " notification-unread"}`}
                key={notification.id}
              >
                {notification.taskId ? (
                  <Link className="notification-content" href={`/tasks/${notification.taskId}`}>
                    {content}
                  </Link>
                ) : (
                  <div className="notification-content">{content}</div>
                )}
                <div className="notification-actions">
                  {notification.read ? (
                    <span className="notification-read-state">Read</span>
                  ) : (
                    <button
                      className="notification-read-button"
                      disabled={markingTarget !== null}
                      onClick={() => void markRead([notification.id], notification.id)}
                      type="button"
                    >
                      {markingTarget === notification.id ? "Updating..." : "Mark as read"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty">No Git progress changes currently require team attention.</div>
      )}
    </section>
  );
}
