ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS parent_session_id UUID REFERENCES agent_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS agent_sessions_parent_idx
  ON agent_sessions(parent_session_id);
