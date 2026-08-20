CREATE TABLE IF NOT EXISTS task_dependency_revisions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  previous_dependencies JSONB NOT NULL DEFAULT '[]'::JSONB,
  next_dependencies JSONB NOT NULL DEFAULT '[]'::JSONB,
  added_dependencies JSONB NOT NULL DEFAULT '[]'::JSONB,
  removed_dependencies JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_dependency_revisions_task_idx
  ON task_dependency_revisions(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS task_dependency_revisions_project_idx
  ON task_dependency_revisions(project_id, created_at DESC);
