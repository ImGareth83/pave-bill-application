# Billing Workflow Worker (Temporal)

This package contains the Temporal workflow definitions and the standalone worker runtime
for bill-period orchestration.

## Deployment Model
- Workflow logic lives in this package.
- The worker is deployed as a long-lived Node process on AWS EC2.
- Temporal Cloud provides workflow state, task queues, and update delivery.
- The worker calls backend-owned persistence APIs over HTTPS.
- This package no longer includes an Encore app/service entrypoint.

## Requirement Alignment
- One workflow execution runs per bill: `bill/<billId>`.
- The workflow orchestrates the bill lifecycle `OPEN -> CLOSED -> COMPLETED`.
- Add and reject updates are accepted only while the workflow is open.
- Bill close can happen early by update or automatically at `periodEnd`.
- Workflow activities do not connect to the database directly; they call backend APIs only.
- Backend idempotency remains the durable replay mechanism for persistence operations.

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

## Assumptions
- The worker runs as a long-lived process and continuously polls Temporal Cloud.
- The backend base URL is publicly reachable from EC2.
- Backend `/workflow/*` persistence endpoints are intentionally public for the external worker.
- The worker process is configured through environment variables, typically via `.env` and `systemd`.

## Environment
- `BACKEND_API_BASE_URL`: required backend API base URL, e.g. `http://127.0.0.1:4000`
- `TEMPORAL_ADDRESS`: required Temporal server address
- `TEMPORAL_API_KEY`: required for Temporal Cloud; when set, the worker connects with TLS enabled
- `TEMPORAL_NAMESPACE`: required Temporal namespace
- `TEMPORAL_TASK_QUEUE`: required task queue name

Recommended EC2 `.env`:
```bash
BACKEND_API_BASE_URL=https://staging-pave-bill-application-idii.encr.app
TEMPORAL_ADDRESS=ap-southeast-1.aws.api.temporal.io:7233
TEMPORAL_NAMESPACE=pave-bank-workflow.s1uvj
TEMPORAL_TASK_QUEUE=billing-periods
TEMPORAL_API_KEY=<Temporal Cloud API key>
```

## Run
```bash
cd /Users/gareth/workspace/pave-bill-application/workflow
npm install
export BACKEND_API_BASE_URL='http://127.0.0.1:4000'
export TEMPORAL_ADDRESS='localhost:7233'
export TEMPORAL_NAMESPACE='default'
npm run worker
```

Direct worker entrypoint:
```bash
cd /Users/gareth/workspace/pave-bill-application/workflow
export BACKEND_API_BASE_URL='http://127.0.0.1:4000'
export TEMPORAL_ADDRESS='localhost:7233'
export TEMPORAL_NAMESPACE='default'
npm run worker
```

## AWS EC2 Setup
1. Launch an EC2 instance with outbound access to:
- Temporal Cloud on `ap-southeast-1.aws.api.temporal.io:7233`
- the backend public API base URL

2. Install Node.js and clone the repository:
```bash
sudo dnf install -y git nodejs
git clone https://github.com/ImGareth83/pave-bill-application.git
cd pave-bill-application/workflow
npm install
```

3. Create `.env` in the workflow directory with the runtime settings above.

4. Run the worker under `systemd`, for example:
```ini
[Unit]
Description=Pave Bill Temporal Worker
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ec2-user/pave-bill-application/workflow
EnvironmentFile=/home/ec2-user/pave-bill-application/workflow/.env
ExecStart=/usr/bin/npm run worker
Restart=always
RestartSec=5
User=ec2-user

[Install]
WantedBy=multi-user.target
```

5. Start and verify:
```bash
sudo systemctl daemon-reload
sudo systemctl enable pave-bill-worker
sudo systemctl start pave-bill-worker
sudo journalctl -u pave-bill-worker -f
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
- The worker is intended to run outside Encore runtime, so configuration is read from plain environment variables only.

## Accepted Risks
- Because the worker is external and invokes backend APIs over HTTP, the backend `/workflow/*` persistence endpoints are intentionally public.
- This means external callers can hit those endpoints directly and bypass the intended public API orchestration path.
- Idempotency still protects duplicate payload replays, but it does not stop a caller from issuing a new valid persistence request against those workflow endpoints.
- Running only one EC2 worker instance is a deliberate simplification; instance loss pauses workflow progress until the service is restarted elsewhere.
