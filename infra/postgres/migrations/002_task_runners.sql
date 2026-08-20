CREATE TABLE IF NOT EXISTS task_runners (
  id UUID PRIMARY KEY,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  integration_id UUID REFERENCES integration_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'aio-sandbox',
  container_name TEXT NOT NULL UNIQUE,
  image TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'stopped', 'failed', 'destroyed')),
  base_url TEXT,
  host_port INTEGER,
  workspace_path TEXT NOT NULL,
  container_workspace_path TEXT NOT NULL DEFAULT '/home/gem/workspace',
  credential_ref TEXT NOT NULL,
  resource_limits JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  ,CHECK (num_nonnulls(task_id, integration_id) = 1)
);

CREATE INDEX IF NOT EXISTS task_runners_status_idx ON task_runners(status);
CREATE UNIQUE INDEX IF NOT EXISTS task_runners_task_unique_idx
  ON task_runners(task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS task_runners_integration_unique_idx
  ON task_runners(integration_id) WHERE integration_id IS NOT NULL;
