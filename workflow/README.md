# Billing Workflow (Temporal)

This package contains the Temporal worker for bill-period orchestration.

## Responsibilities
- Run one workflow per bill: `bill/<billId>`
- Accept update operations for:
  - add line item
  - reject line item
  - close bill early
- Auto-close and finalize the bill when `periodEnd` is reached
- Persist bill mutations directly to Postgres through activities
- Dedupe concurrent/retried workflow updates by `requestId`
- Persist add/reject activity responses in `idempotency_records` to stay safe under Temporal retries
- Persist close + complete atomically in one database transaction

## Environment
- `DATABASE_URL`: Postgres connection string
- `TEMPORAL_ADDRESS`: Temporal server address, defaults to `localhost:7233`
- `TEMPORAL_NAMESPACE`: Temporal namespace, defaults to `default`
- `TEMPORAL_TASK_QUEUE`: Task queue name, defaults to `billing-periods`

Local example using Encore-managed Postgres (`encoredotdev/postgres:15`):
```bash
export DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55001/postgres'
```

## Run
```bash
cd /Users/gareth/workspace/pave-bill-application
npm install
npm run worker
```

## Verify
```bash
cd /Users/gareth/workspace/pave-bill-application
npm run typecheck
npm run test:workflow
```

## Notes
- Workflow update request payloads include `requestId` so the workflow can dedupe in-flight and completed retries.
- Activities write to the same bill tables used by `backend/`, using a direct Postgres connection from `DATABASE_URL`.
- The workflow keeps the persisted bill lifecycle aligned with the current backend model:
  `OPEN -> CLOSED -> COMPLETED`.
