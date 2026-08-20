ALTER TABLE task_dependency_revisions
  ADD COLUMN IF NOT EXISTS change_kind TEXT NOT NULL DEFAULT 'manual_update',
  ADD COLUMN IF NOT EXISTS change_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'task_dependency_revisions_change_kind_check'
  ) THEN
    ALTER TABLE task_dependency_revisions
      ADD CONSTRAINT task_dependency_revisions_change_kind_check
      CHECK (change_kind IN ('task_created', 'manual_update', 'failure_recovery'));
  END IF;
END
$$;
