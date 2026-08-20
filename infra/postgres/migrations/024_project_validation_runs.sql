CREATE TABLE IF NOT EXISTS project_validation_runs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  integration_queue_id UUID NOT NULL REFERENCES project_integration_queues(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed')),
  commands JSONB NOT NULL DEFAULT '[]'::JSONB,
  results JSONB NOT NULL DEFAULT '[]'::JSONB,
  main_commit TEXT,
  worktree_path TEXT,
  error_message TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_validation_runs_project_idx
  ON project_validation_runs(project_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS project_validation_runs_active_idx
  ON project_validation_runs(project_id)
  WHERE status IN ('queued', 'running');

ALTER TABLE task_runners
  ADD COLUMN IF NOT EXISTS project_validation_run_id UUID
    REFERENCES project_validation_runs(id) ON DELETE CASCADE;

ALTER TABLE task_runners
  DROP CONSTRAINT IF EXISTS task_runners_scope_check;

ALTER TABLE task_runners
  ADD CONSTRAINT task_runners_scope_check CHECK (
    num_nonnulls(task_id, integration_id, project_merge_plan_run_id, project_validation_run_id) = 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS task_runners_project_validation_unique_idx
  ON task_runners(project_validation_run_id)
  WHERE project_validation_run_id IS NOT NULL;
