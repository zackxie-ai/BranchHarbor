ALTER TABLE agent_connections
  ADD COLUMN IF NOT EXISTS credential_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credential_rotated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS credential_revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS credential_last_used_at TIMESTAMPTZ;

UPDATE agent_connections
   SET credential_version = CASE
         WHEN credential_ref IS NOT NULL AND credential_configured_at IS NOT NULL
           THEN GREATEST(credential_version, 1)
         ELSE credential_version
       END,
       credential_rotated_at = COALESCE(credential_rotated_at, credential_configured_at)
 WHERE credential_configured_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS credential_access_events (
  id UUID PRIMARY KEY,
  agent_connection_id UUID NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES users(id),
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  integration_id UUID REFERENCES integration_runs(id) ON DELETE SET NULL,
  session_id UUID REFERENCES agent_sessions(id) ON DELETE SET NULL,
  runner_id UUID REFERENCES task_runners(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('configured', 'rotated', 'used', 'revoked')),
  credential_version INTEGER NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS credential_access_events_connection_idx
  ON credential_access_events(agent_connection_id, created_at DESC);

CREATE INDEX IF NOT EXISTS credential_access_events_actor_idx
  ON credential_access_events(actor_id, created_at DESC);
