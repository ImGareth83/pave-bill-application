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
- Share the same Encore-managed `backend` database as the API service

## Environment
- `TEMPORAL_ADDRESS`: Temporal server address, defaults to `localhost:7233`
- `TEMPORAL_NAMESPACE`: Temporal namespace, defaults to `default`
- `TEMPORAL_TASK_QUEUE`: Task queue name, defaults to `billing-periods`

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
- Activities use Encore `SQLDatabase("backend")`, so workflow and backend share the same configured Encore-managed database instead of separate DB config paths.
- The workflow keeps the persisted bill lifecycle aligned with the current backend model:
  `OPEN -> CLOSED -> COMPLETED`.
- Backend write endpoints also keep their own `PENDING` / `COMPLETED` idempotency records. Workflow/activity idempotency is the second line of defense for Temporal retries and replay recovery.
- `createBill` is intentionally resumable rather than atomic across SQL commit and workflow start. Bills persist with `workflow_state='NOT_STARTED'` until backend successfully starts the Temporal workflow and marks them `STARTED`.
