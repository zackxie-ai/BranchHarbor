CREATE TABLE IF NOT EXISTS agent_credential_leases (
  id UUID PRIMARY KEY,
  agent_connection_id UUID NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL,
  actor_id UUID NOT NULL REFERENCES users(id),
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  integration_id UUID REFERENCES integration_runs(id) ON DELETE SET NULL,
  session_id UUID REFERENCES agent_sessions(id) ON DELETE SET NULL,
  runner_id UUID REFERENCES task_runners(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'expired', 'revoked')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS agent_credential_leases_connection_idx
  ON agent_credential_leases(agent_connection_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS agent_credential_leases_active_idx
  ON agent_credential_leases(expires_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS agent_credential_leases_session_idx
  ON agent_credential_leases(session_id, issued_at DESC);
