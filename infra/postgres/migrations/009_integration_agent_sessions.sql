ALTER TABLE agent_sessions
  ALTER COLUMN task_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS integration_id UUID REFERENCES integration_runs(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'agent_sessions_scope_check'
  ) THEN
    ALTER TABLE agent_sessions
      ADD CONSTRAINT agent_sessions_scope_check CHECK (
        (task_id IS NOT NULL AND integration_id IS NULL)
        OR (task_id IS NULL AND integration_id IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS agent_sessions_integration_idx
  ON agent_sessions(integration_id, started_at DESC);
