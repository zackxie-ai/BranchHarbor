CREATE TABLE IF NOT EXISTS task_preview_runs (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  runner_id UUID NOT NULL REFERENCES task_runners(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1024 AND 65535),
  status TEXT NOT NULL CHECK (
    status IN ('starting', 'running', 'completed', 'stopped', 'failed')
  ),
  shell_session_id TEXT NOT NULL,
  preview_url TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  error_message TEXT,
  started_by UUID NOT NULL REFERENCES users(id),
  stopped_by UUID REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS task_preview_runs_active_task_idx
  ON task_preview_runs(task_id)
  WHERE status IN ('starting', 'running');

CREATE INDEX IF NOT EXISTS task_preview_runs_task_history_idx
  ON task_preview_runs(task_id, started_at DESC);

CREATE INDEX IF NOT EXISTS task_preview_runs_runner_idx
  ON task_preview_runs(runner_id, updated_at DESC);
