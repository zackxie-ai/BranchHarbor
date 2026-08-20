CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS agent_connections (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('acp', 'yoke', 'local')),
  credential_ref TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'disabled', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  gitea_owner TEXT NOT NULL,
  gitea_repository TEXT NOT NULL,
  repository_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  local_repository_path TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  verification_commands JSONB NOT NULL DEFAULT '[]'::JSONB,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'workspace_ready', 'active', 'submitted', 'changes_requested', 'rejected', 'integrating', 'merged', 'cancelled')
  ),
  base_branch TEXT NOT NULL DEFAULT 'main',
  base_commit TEXT,
  branch_name TEXT,
  worktree_path TEXT,
  assigned_user_id UUID NOT NULL REFERENCES users(id),
  agent_connection_id UUID REFERENCES agent_connections(id),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks(project_id, status);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_connection_id UUID REFERENCES agent_connections(id),
  runner_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'waiting', 'stopped', 'failed', 'completed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS change_requests (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (
    status IN ('submitted', 'changes_requested', 'rejected', 'approved_for_integration', 'integrating', 'awaiting_final_approval', 'merged', 'integration_failed')
  ),
  summary TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  changed_files JSONB NOT NULL,
  diff_stat TEXT NOT NULL,
  verification_results JSONB NOT NULL DEFAULT '[]'::JSONB,
  risks JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP INDEX IF EXISTS active_change_request_per_task_idx;
CREATE UNIQUE INDEX active_change_request_per_task_idx
  ON change_requests(task_id)
  WHERE status IN ('submitted', 'approved_for_integration', 'integrating', 'awaiting_final_approval');

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY,
  change_request_id UUID NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('request_changes', 'reject', 'approve_integration', 'approve_final')),
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integration_runs (
  id UUID PRIMARY KEY,
  change_request_id UUID NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('merging', 'needs_agent', 'verification_failed', 'awaiting_final_approval', 'merged', 'failed')),
  branch_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  merge_commit TEXT,
  report JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO organizations (id, slug, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'cloudagent', 'CloudAgent Team')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, email, name)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'admin@cloudagent.local', 'CloudAgent Admin'),
  ('00000000-0000-4000-8000-000000000102', 'member@cloudagent.local', 'Demo Member')
ON CONFLICT (id) DO NOTHING;

INSERT INTO memberships (organization_id, user_id, role)
VALUES
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 'admin'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000102', 'member')
ON CONFLICT (organization_id, user_id) DO NOTHING;

INSERT INTO agent_connections (id, user_id, provider, display_name, protocol, credential_ref)
VALUES
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', 'codex', 'Admin Codex', 'local', 'openbao://users/admin/codex'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000102', 'codex', 'Member Codex', 'local', 'openbao://users/member/codex')
ON CONFLICT (id) DO NOTHING;
