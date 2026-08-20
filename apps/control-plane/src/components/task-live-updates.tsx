"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

interface LiveSession {
  id: string;
  status: string;
  lastSequence: number;
}

export function TaskLiveUpdates({
  sessions,
  hasRunningWorkflow,
}: {
  sessions: LiveSession[];
  hasRunningWorkflow: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (refreshTimer) {
        return;
      }
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        router.refresh();
      }, 1_000);
    };

    const sources = sessions
      .filter((session) => ["starting", "running", "waiting"].includes(session.status))
      .map((session) => {
        const source = new EventSource(
          `/api/agent-sessions/${session.id}/events?after=${session.lastSequence}`,
        );
        source.addEventListener("agent-event", scheduleRefresh);
        source.addEventListener("session-status", scheduleRefresh);
        return source;
      });

    const workflowTimer = hasRunningWorkflow
      ? setInterval(() => router.refresh(), 2_000)
      : undefined;

    return () => {
      sources.forEach((source) => source.close());
      if (workflowTimer) {
        clearInterval(workflowTimer);
      }
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    };
  }, [hasRunningWorkflow, router, sessions]);

  return null;
}
