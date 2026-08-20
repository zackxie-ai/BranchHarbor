ALTER TABLE agent_connections
  ADD COLUMN IF NOT EXISTS launcher_command TEXT,
  ADD COLUMN IF NOT EXISTS launcher_arguments JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS credential_environment_variable TEXT NOT NULL DEFAULT 'OPENAI_API_KEY';

UPDATE agent_connections
   SET launcher_command = COALESCE(launcher_command, 'codex')
 WHERE provider = 'codex';

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS stop_reason TEXT,
  ADD COLUMN IF NOT EXISTS transport_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS next_event_sequence INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS agent_permission_requests (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  provider_request_id TEXT NOT NULL,
  tool_call JSONB NOT NULL,
  options JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'selected', 'cancelled', 'expired')
  ),
  selected_option_id TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id),
  UNIQUE (session_id, provider_request_id)
);

CREATE INDEX IF NOT EXISTS agent_permission_requests_pending_idx
  ON agent_permission_requests(session_id, requested_at)
  WHERE status = 'pending';
