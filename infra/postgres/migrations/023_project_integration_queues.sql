CREATE TABLE IF NOT EXISTS project_integration_queues (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  source TEXT NOT NULL CHECK (source IN ('deterministic', 'semantic')),
  source_merge_plan_run_id UUID REFERENCES project_merge_plan_agent_runs(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  cancelled_by UUID REFERENCES users(id),
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS project_integration_queues_active_idx
  ON project_integration_queues(project_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS project_integration_queues_project_idx
  ON project_integration_queues(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_integration_queue_items (
  queue_id UUID NOT NULL REFERENCES project_integration_queues(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position > 0),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  change_request_id UUID NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  head_commit TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (queue_id, position),
  UNIQUE (queue_id, task_id),
  UNIQUE (queue_id, change_request_id)
);

CREATE INDEX IF NOT EXISTS project_integration_queue_items_task_idx
  ON project_integration_queue_items(task_id, queue_id);

CREATE INDEX IF NOT EXISTS project_integration_queue_items_change_request_idx
  ON project_integration_queue_items(change_request_id, queue_id);
