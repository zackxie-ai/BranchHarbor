CREATE TABLE IF NOT EXISTS project_merge_plan_agent_runs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_connection_id UUID NOT NULL REFERENCES agent_connections(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (
    status IN ('starting', 'running', 'completed', 'invalid', 'failed', 'cancelled')
  ),
  instruction TEXT NOT NULL,
  baseline_plan JSONB NOT NULL,
  dependencies JSONB NOT NULL DEFAULT '[]'::JSONB,
  analysis_prompt TEXT NOT NULL,
  suggestion JSONB,
  raw_response TEXT,
  error_message TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_merge_plan_agent_runs_project_idx
  ON project_merge_plan_agent_runs(project_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS project_merge_plan_agent_runs_active_idx
  ON project_merge_plan_agent_runs(project_id)
  WHERE status IN ('starting', 'running');

ALTER TABLE task_runners
  ADD COLUMN IF NOT EXISTS project_merge_plan_run_id UUID
    REFERENCES project_merge_plan_agent_runs(id) ON DELETE CASCADE;

ALTER TABLE task_runners
  DROP CONSTRAINT IF EXISTS task_runners_check;

ALTER TABLE task_runners
  DROP CONSTRAINT IF EXISTS task_runners_scope_check;

ALTER TABLE task_runners
  ADD CONSTRAINT task_runners_scope_check CHECK (
    num_nonnulls(task_id, integration_id, project_merge_plan_run_id) = 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS task_runners_project_merge_plan_unique_idx
  ON task_runners(project_merge_plan_run_id)
  WHERE project_merge_plan_run_id IS NOT NULL;

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS project_merge_plan_run_id UUID
    REFERENCES project_merge_plan_agent_runs(id) ON DELETE CASCADE;

ALTER TABLE agent_sessions
  DROP CONSTRAINT IF EXISTS agent_sessions_scope_check;

ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_scope_check CHECK (
    num_nonnulls(task_id, integration_id, project_merge_plan_run_id) = 1
  );

CREATE INDEX IF NOT EXISTS agent_sessions_project_merge_plan_idx
  ON agent_sessions(project_merge_plan_run_id, started_at DESC);
