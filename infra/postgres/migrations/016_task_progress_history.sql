CREATE TABLE IF NOT EXISTS task_workspace_snapshots (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  main_commit TEXT NOT NULL,
  committed_files JSONB NOT NULL DEFAULT '[]'::JSONB,
  uncommitted_files JSONB NOT NULL DEFAULT '[]'::JSONB,
  main_changed_files JSONB NOT NULL DEFAULT '[]'::JSONB,
  overlapping_files JSONB NOT NULL DEFAULT '[]'::JSONB,
  main_commits_since_base INTEGER NOT NULL DEFAULT 0,
  working_tree_clean BOOLEAN NOT NULL,
  observed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_workspace_snapshots_task_idx
  ON task_workspace_snapshots(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS task_workspace_snapshots_project_idx
  ON task_workspace_snapshots(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_notifications (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  source_snapshot_id UUID REFERENCES task_workspace_snapshots(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'danger')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS project_notifications_project_idx
  ON project_notifications(project_id, created_at DESC);
