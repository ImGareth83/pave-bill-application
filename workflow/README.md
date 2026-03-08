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
- Invoke backend-owned persistence APIs through activities
- Dedupe concurrent/retried workflow updates by `requestId`
- Rely on backend idempotency records to stay safe under Temporal retries
- Finalize the bill through a single backend API that closes and completes atomically
- Run as its own Encore app, separate from the backend app

## Environment
- `BACKEND_API_BASE_URL`: backend API base URL, configured as an Encore secret, e.g. `http://127.0.0.1:4000`
- `TEMPORAL_ADDRESS`: required Temporal server address
- `TEMPORAL_API_KEY`: Temporal Cloud API key should be configured as an Encore secret; when set, the worker connects with TLS enabled
- `TEMPORAL_NAMESPACE`: required Temporal namespace
- `TEMPORAL_TASK_QUEUE`: Task queue name, defaults to `billing-periods`

## Run
```bash
cd /Users/gareth/workspace/pave-bill-application/workflow
npm install
export BACKEND_API_BASE_URL='http://127.0.0.1:4000'
export TEMPORAL_ADDRESS='localhost:7233'
export TEMPORAL_NAMESPACE='default'
encore run
```

Direct worker entrypoint:
```bash
cd /Users/gareth/workspace/pave-bill-application/workflow
export BACKEND_API_BASE_URL='http://127.0.0.1:4000'
export TEMPORAL_ADDRESS='localhost:7233'
export TEMPORAL_NAMESPACE='default'
npm run worker
```

## Verify
```bash
cd /Users/gareth/workspace/pave-bill-application/workflow
npm run typecheck
npm test
```

## Notes
- Workflow update request payloads include `requestId` so the workflow can dedupe concurrent in-flight updates.
- Activities call backend workflow persistence endpoints over HTTP using `BACKEND_API_BASE_URL`.
- The workflow keeps the persisted bill lifecycle aligned with the current backend model:
  `OPEN -> CLOSED -> COMPLETED`.
- Backend owns all SQL writes and idempotency records for both public endpoints and workflow persistence endpoints.
- `createBill` is intentionally resumable rather than atomic across SQL commit and workflow start. Bills persist with `workflow_state='NOT_STARTED'` until backend successfully starts the Temporal workflow and marks them `STARTED`.
- Activity tests mock backend API calls instead of connecting to Postgres.
- [`workflow/encore.app`](/Users/gareth/workspace/pave-bill-application/workflow/encore.app) makes this directory its own Encore app root.

## Accepted Risks
- Because the workflow app is separate and invokes backend APIs over HTTP, the backend `/workflow/*` persistence endpoints are intentionally public.
- This means external callers can hit those endpoints directly and bypass the intended public API orchestration path.
- Idempotency still protects duplicate payload replays, but it does not stop a caller from issuing a new valid persistence request against those workflow endpoints.
