CREATE TABLE IF NOT EXISTS project_notification_reads (
  notification_id UUID NOT NULL REFERENCES project_notifications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS project_notification_reads_user_idx
  ON project_notification_reads(user_id, read_at DESC);
