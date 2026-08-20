ALTER TABLE agent_connections
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS credential_configured_at TIMESTAMPTZ;

UPDATE agent_connections
   SET credential_ref = NULL,
       credential_configured_at = NULL,
       protocol = 'local'
 WHERE credential_ref LIKE 'openbao://users/%';

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS prompt TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS final_message TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS provider_session_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS agent_events (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS agent_events_session_idx
  ON agent_events(session_id, sequence_number);
