ALTER TABLE bills
  ADD COLUMN workflow_state TEXT NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (workflow_state IN ('NOT_STARTED', 'STARTED'));

UPDATE bills
SET workflow_state = 'STARTED';
