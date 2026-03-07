# Billing Workflow (Temporal)

This package is a standalone Encore app that hosts the Temporal worker for bill-period
orchestration.

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
- Connect directly to the backend Postgres database over `DATABASE_URL`
- Run as its own Encore app, separate from the backend app

## Environment
- `DATABASE_URL`: Postgres connection string for the backend database
- `TEMPORAL_ADDRESS`: Temporal server address, defaults to `localhost:7233`
- `TEMPORAL_API_KEY`: optional Temporal Cloud API key; when set, the worker connects with TLS enabled
- `TEMPORAL_NAMESPACE`: Temporal namespace, defaults to `default`
- `TEMPORAL_TASK_QUEUE`: Task queue name, defaults to `billing-periods`

## Run
```bash
cd /Users/gareth/workspace/pave-bill-application/workflow
npm install
export DATABASE_URL='postgres://...'
encore run
```

Direct worker entrypoint:
```bash
cd /Users/gareth/workspace/pave-bill-application/workflow
export DATABASE_URL='postgres://...'
npm run worker
```

## Verify
```bash
cd /Users/gareth/workspace/pave-bill-application/workflow
npm run typecheck
npm test
```

## Notes
- Workflow update request payloads include `requestId` so the workflow can dedupe in-flight and completed retries.
- Activities use raw Postgres connections through `DATABASE_URL`, pointing at the same schema the backend app reads and writes.
- The workflow keeps the persisted bill lifecycle aligned with the current backend model:
  `OPEN -> CLOSED -> COMPLETED`.
- Backend write endpoints also keep their own `PENDING` / `COMPLETED` idempotency records. Workflow/activity idempotency is the second line of defense for Temporal retries and replay recovery.
- `createBill` is intentionally resumable rather than atomic across SQL commit and workflow start. Bills persist with `workflow_state='NOT_STARTED'` until backend successfully starts the Temporal workflow and marks them `STARTED`.
- DB-backed activity tests run only when `DATABASE_URL` is set.
- [`workflow/encore.app`](/Users/gareth/workspace/pave-bill-application/workflow/encore.app) makes this directory its own Encore app root.
