# Billing Backend (Encore)

This service is the public Encore API for bill management.

## Features
- Create bills
- Start one Temporal workflow per bill period
- Add line items to open bills through Temporal updates
- Reject line items while bill is open through Temporal updates
- Close bills early through Temporal updates
- Read bill, line-item, and invoice state from Postgres
- List bills by status (`OPEN`, `CLOSED`, `COMPLETED`)
- Currency support: `USD`, `GEL`
- Idempotency support on POST endpoints via `Idempotency-Key`
- Recover `createBill` when the bill row exists but workflow start has not completed yet

## Prerequisites
- Encore CLI installed
- Docker running (required by `encore run` / `encore test`)

## Run locally
```bash
cd /Users/gareth/workspace/pave-bill-application/backend
encore run
```

Developer dashboard:
- http://localhost:9400

API base URL:
- http://127.0.0.1:4000

Health endpoints:
- `GET /livez`
- `GET /readyz`

## API Endpoints
- `GET /livez`
- `GET /readyz`
- `POST /bills`
- `POST /bills/:billId/line-items`
- `POST /bills/:billId/line-items/:lineItemId/reject`
- `POST /bills/:billId/close`
- `POST /bills/:billId/complete`
- `GET /bills/:billId`
- `GET /bills?status=OPEN|CLOSED|COMPLETED`
- `GET /bills/:billId/line-items`
- `GET /bills/:billId/invoice`

Notes:
- `status` is required on `GET /bills`.
- Invoice retrieval is allowed only when the bill status is `COMPLETED`.
- Rejected line items are excluded from invoice totals.
- `POST /bills/:billId/complete` no longer performs completion. It only returns completion data if the workflow has already completed the bill; otherwise it returns `BillCompletionManagedByWorkflow`.

### Example: Liveness
```bash
curl 'http://127.0.0.1:4000/livez'
```

### Example: Health
```bash
curl 'http://127.0.0.1:4000/readyz'
```

## Lifecycle
1. Create bill (`OPEN`)
2. Backend starts workflow `bill/<billId>`
3. Add / reject line items while the bill is `OPEN`
4. Close bill early through `POST /bills/:billId/close`, or let the workflow close it automatically at `periodEnd`
5. Workflow persists `OPEN -> CLOSED -> COMPLETED`
6. Invoice is available only after completion and excludes rejected items

### Example: Create bill
```bash
curl -X POST 'http://127.0.0.1:4000/bills' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-bill-1111' \
  -d '{
    "currency": "USD",
    "periodStart": "2026-03-01T00:00:00Z",
    "periodEnd": "2026-03-31T23:59:59Z"
  }'
```

### Example: Add line item
```bash
curl -X POST 'http://127.0.0.1:4000/bills/<billId>/line-items' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: add-line-item-1111' \
  -d '{
    "description": "Trading Fee",
    "amount": "25.50",
    "currency": "USD"
  }'
```

### Example: Reject line item
```bash
curl -X POST 'http://127.0.0.1:4000/bills/<billId>/line-items/<lineItemId>/reject' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: reject-line-item-1111' \
  -d '{
    "reason": "Duplicate charge"
  }'
```

### Example: Close bill
```bash
curl -X POST 'http://127.0.0.1:4000/bills/<billId>/close' \
  -H 'Idempotency-Key: close-bill-1111'
```

### Example: Complete bill
```bash
curl -X POST 'http://127.0.0.1:4000/bills/<billId>/complete' \
  -H 'Idempotency-Key: complete-bill-1111'
```

Expected behavior:
- if the workflow has already completed the bill, this returns the completion payload
- otherwise it returns `BillCompletionManagedByWorkflow`

## Testing
Run backend unit tests:
```bash
cd /Users/gareth/workspace/pave-bill-application/backend
npm test
```

Run Encore-managed tests for the backend app:
```bash
cd /Users/gareth/workspace/pave-bill-application/backend
encore test
```

## Database access
```bash
cd /Users/gareth/workspace/pave-bill-application/backend
encore db shell backend
```

## Migrations
- `1_create_tables.up.sql`: base schema
- `2_add_idempotency_pending_state.up.sql`: backend-owned `PENDING` / `COMPLETED` idempotency state
- `3_add_bill_workflow_state.up.sql`: tracks whether a persisted bill has had its workflow started
