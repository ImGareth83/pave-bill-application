# Pave Bill Application

This repository contains the billing backend, the Temporal workflow worker, and the
shared architecture diagram for the current deployment model.

## Components
- [backend/README.md](/Users/gareth/workspace/pave-bill-application/backend/README.md)
  Encore Cloud backend API, persistence model, public API semantics, Temporal integration,
  and staging screenshots.
- [workflow/README.md](/Users/gareth/workspace/pave-bill-application/workflow/README.md)
  Standalone Temporal workflow worker package, EC2 runtime model, worker configuration,
  and deployment notes.
- [diagrams.drawio.pdf](/Users/gareth/workspace/pave-bill-application/diagrams.drawio.pdf)
  Architecture and request-flow diagram for backend, Temporal Cloud, EC2 worker, and
  persistence ownership.
- [diagrams.drawio](/Users/gareth/workspace/pave-bill-application/diagrams.drawio)
  Source file for the diagram.

## Current Architecture
- Backend API runs on Encore Cloud.
- Temporal orchestration runs on Temporal Cloud.
- The workflow worker runs as a long-lived Node process on AWS EC2.
- Backend owns all database writes and idempotency state.
- The worker executes workflow logic and calls backend `/workflow/*` persistence APIs.

## Lifecycle
- Bills move through `OPEN -> CLOSED -> COMPLETED`.
- `createBill` starts one Temporal workflow per bill.
- `addLineItem`, `rejectLineItem`, and `closeBill` are orchestrated through Temporal workflow updates.
- Bills close early by API request or automatically at `periodEnd`.
- Invoice reads are available only after completion and exclude rejected line items.

## Where To Read Next
- For API contract and backend behavior:
  [backend/README.md](/Users/gareth/workspace/pave-bill-application/backend/README.md)
- For worker runtime, EC2 setup, and Temporal worker behavior:
  [workflow/README.md](/Users/gareth/workspace/pave-bill-application/workflow/README.md)
- For the visual system overview:
  [diagrams.drawio.pdf](/Users/gareth/workspace/pave-bill-application/diagrams.drawio.pdf)
