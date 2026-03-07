ALTER TABLE idempotency_records
  ADD COLUMN state TEXT NOT NULL DEFAULT 'COMPLETED'
    CHECK (state IN ('PENDING', 'COMPLETED'));

ALTER TABLE idempotency_records
  ALTER COLUMN response_json DROP NOT NULL;

ALTER TABLE idempotency_records
  ALTER COLUMN http_code DROP NOT NULL;

ALTER TABLE idempotency_records
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
