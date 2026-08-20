CREATE TABLE IF NOT EXISTS task_workspace_backups (
  task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_name TEXT NOT NULL,
  remote_head_commit TEXT,
  checkpoint_commit TEXT,
  working_tree_clean BOOLEAN NOT NULL DEFAULT TRUE,
  changed_files JSONB NOT NULL DEFAULT '[]'::JSONB,
  status TEXT NOT NULL CHECK (status IN ('synced', 'failed', 'restored')),
  error_message TEXT,
  sync_attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,
  last_checkpoint_at TIMESTAMPTZ,
  last_restored_at TIMESTAMPTZ,
  restored_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_workspace_backups_project_idx
  ON task_workspace_backups(project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS task_workspace_backups_status_idx
  ON task_workspace_backups(status, updated_at DESC);
