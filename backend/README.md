# Billing Backend (Encore)

This project is an Encore TypeScript backend for bill management.

## Features
- Create bills
- Add line items to open bills
- Reject line items while bill is open
- Close bills (`OPEN -> CLOSED`)
- Complete bills (`CLOSED -> COMPLETED`)
- Compute and persist total bill amount during bill completion
- List bills by status (`OPEN`, `CLOSED`, `COMPLETED`)
- Fetch bill line items
- Fetch bill invoice view (completed bills only)
- Currency support: `USD`, `GEL`
- Idempotency support on POST endpoints via `Idempotency-Key`

## Prerequisites
- Encore CLI installed
- Docker running (required by `encore run` / `encore test`)

## Run locally
```bash
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
2. Add / reject line items (allowed only when `OPEN`)
3. Close bill (`CLOSED`)
4. Complete bill (`COMPLETED`) - total is calculated here from `ADDED` line items

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

## Testing
Run integration tests via Encore:
```bash
encore test
```

## Database access
```bash
encore db shell <database-name> --env=local --superuser
```
