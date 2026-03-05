CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'GEL')),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'COMPLETED')),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  total_minor BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE bill_line_items (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'GEL')),
  status TEXT NOT NULL CHECK (status IN ('ADDED', 'REJECTED')) DEFAULT 'ADDED',
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bill_line_items_bill_id_created_at_idx
  ON bill_line_items (bill_id, created_at);

CREATE INDEX bills_status_created_at_idx
  ON bills (status, created_at DESC);

CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json JSONB NOT NULL,
  http_code INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, idem_key)
);
