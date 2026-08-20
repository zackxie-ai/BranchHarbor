ALTER TABLE audit_events
  DROP CONSTRAINT IF EXISTS audit_events_project_id_fkey;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE audit_events
  DROP CONSTRAINT IF EXISTS audit_events_task_id_fkey;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_task_id_fkey
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS audit_events_organization_history_idx
  ON audit_events(organization_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_events_organization_type_idx
  ON audit_events(organization_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_organization_actor_idx
  ON audit_events(organization_id, actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_events_organization_project_idx
  ON audit_events(organization_id, project_id, created_at DESC)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_events_organization_task_idx
  ON audit_events(organization_id, task_id, created_at DESC)
  WHERE task_id IS NOT NULL;
