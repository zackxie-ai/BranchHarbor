CREATE TABLE IF NOT EXISTS project_memberships (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS project_memberships_user_idx
  ON project_memberships(user_id, project_id);

INSERT INTO project_memberships (project_id, user_id, added_by)
SELECT id, created_by, created_by
  FROM projects
ON CONFLICT (project_id, user_id) DO NOTHING;

INSERT INTO project_memberships (project_id, user_id, added_by)
SELECT DISTINCT task.project_id, task.assigned_user_id, project.created_by
  FROM tasks task
  JOIN projects project ON project.id = task.project_id
ON CONFLICT (project_id, user_id) DO NOTHING;
