ALTER TABLE task_workspace_snapshots
  ADD COLUMN IF NOT EXISTS structural_conflicts JSONB NOT NULL DEFAULT '[]'::JSONB;
