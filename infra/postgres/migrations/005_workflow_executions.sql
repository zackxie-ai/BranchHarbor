CREATE TABLE IF NOT EXISTS workflow_executions (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'terminated')),
  result JSONB,
  error_message TEXT,
  started_by UUID NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workflow_id, run_id)
);

CREATE INDEX IF NOT EXISTS workflow_executions_entity_idx
  ON workflow_executions(entity_type, entity_id, started_at DESC);

CREATE INDEX IF NOT EXISTS workflow_executions_status_idx
  ON workflow_executions(status, updated_at DESC);
