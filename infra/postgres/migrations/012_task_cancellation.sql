ALTER TABLE change_requests
  DROP CONSTRAINT IF EXISTS change_requests_status_check;

ALTER TABLE change_requests
  ADD CONSTRAINT change_requests_status_check CHECK (
    status IN (
      'submitted',
      'changes_requested',
      'rejected',
      'cancelled',
      'approved_for_integration',
      'integrating',
      'awaiting_final_approval',
      'merged',
      'integration_failed'
    )
  );
