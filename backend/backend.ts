import { api, APIError } from "encore.dev/api";
import { currentRequest } from "encore.dev";
import {
  Client as TemporalClient,
  Connection as TemporalConnection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowUpdateFailedError,
  WorkflowUpdateRPCTimeoutOrCancelledError,
  ApplicationFailure
} from "@temporalio/client";
import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { db, type Tx } from "./db";

type BillStatus = "OPEN" | "CLOSED" | "COMPLETED";
type LineItemStatus = "ADDED" | "REJECTED";
type Currency = "USD" | "GEL";
type QueryExecutor = Pick<Tx, "queryRow">;
type BillReadExecutor = Pick<Tx, "queryRow" | "query">;

interface CreateBillParams {
  currency: Currency;
  periodStart: string;
  periodEnd: string;
}

interface CreateBillResponse {
  billId: string;
  status: BillStatus;
  periodStart: string;
  periodEnd: string;
}

interface AddLineItemParams {
  billId: string;
  description: string;
  amount: string;
  currency: Currency;
}

interface WorkflowAddLineItemParams extends AddLineItemParams {
  requestId: string;
}

interface AddLineItemResponse {
  lineItemId: string;
  billId: string;
  description: string;
  amount: string;
  status: "ADDED";
  createdAt: string;
}

interface RejectLineItemParams {
  billId: string;
  lineItemId: string;
  reason: string;
}

interface WorkflowRejectLineItemParams extends RejectLineItemParams {
  requestId: string;
}

interface RejectLineItemResponse {
  lineItemId: string;
  billId: string;
  status: "REJECTED";
  rejectedAt: string;
  reason: string;
}

interface CloseBillParams {
  billId: string;
}

interface CloseBillResponse {
  billId: string;
  status: "CLOSED";
  closedAt: string;
  totalAmount: string;
  lineItems: Array<{
    id: string;
    description: string;
    amount: string;
    currency: Currency;
    createdAt: string;
  }>;
}

interface CompleteBillParams {
  billId: string;
}

interface WorkflowCloseAndCompleteBillParams {
  billId: string;
}

interface CompleteBillResponse {
  billId: string;
  status: "COMPLETED";
  totalAmount: string;
  completedAt: string;
}

interface GetBillParams {
  billId: string;
}

interface BillSummary {
  billId: string;
  status: BillStatus;
  currency: Currency;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  closedAt: string | null;
  completedAt: string | null;
  totalAmount: string;
}

interface QueryBillsParams {
  status: "OPEN" | "CLOSED" | "COMPLETED";
}

interface QueryBillsResponse {
  bills: BillSummary[];
}

interface GetLineItemsParams {
  billId: string;
}

interface LineItem {
  id: string;
  billId: string;
  description: string;
  amount: string;
  currency: Currency;
  status: LineItemStatus;
  reason: string | null;
  createdAt: string;
  rejectedAt: string | null;
}

interface GetLineItemsResponse {
  items: LineItem[];
}

interface InvoiceResponse {
  billId: string;
  status: "COMPLETED";
  currency: Currency;
  totalAmount: string;
  lineItems: Array<{
    id: string;
    description: string;
    amount: string;
    currency: Currency;
    createdAt: string;
  }>;
}

interface LivenessResponse {
  ok: true;
  service: "backend";
}

interface HealthResponse {
  ok: true;
  service: "backend";
  checks: {
    database: "ok";
  };
}

interface BillRow {
  id: string;
  currency: Currency;
  status: BillStatus;
  workflow_state: "NOT_STARTED" | "STARTED";
  period_start: Date | string;
  period_end: Date | string;
  created_at: Date | string;
  closed_at: Date | string | null;
  completed_at: Date | string | null;
  total_minor: string | number | bigint;
}

interface LineItemRow {
  id: string;
  bill_id: string;
  description: string;
  amount_minor: string | number | bigint;
  currency: Currency;
  status: LineItemStatus;
  rejection_reason: string | null;
  created_at: Date | string;
  rejected_at: Date | string | null;
}

interface IdempotencyRow {
  request_hash: string;
  response_json: unknown | null;
  state?: "PENDING" | "COMPLETED";
}

let temporalConnectionPromise: Promise<TemporalConnection> | undefined;
let temporalClientPromise: Promise<TemporalClient> | undefined;

export const createBill = api(
  { expose: true, auth: false, method: "POST", path: "/bills" },
  async (params: CreateBillParams): Promise<CreateBillResponse> => {
    validateCurrency(params.currency);
    const periodStart = parseDate(params.periodStart, "periodStart");
    const periodEnd = parseDate(params.periodEnd, "periodEnd");
    if (periodEnd <= periodStart) {
      throw invalid("InvalidPeriod", "periodEnd must be after periodStart");
    }

    const scope = "create_bill";
    const idemKey = requireIdempotencyKey();
    const reqHash = hashRequest({ ...params });

    const response = await withIdempotency<CreateBillResponse>(scope, idemKey, reqHash, async (tx) => {
      const billId = uuidv7();
      await tx.exec`
        INSERT INTO bills (id, currency, status, workflow_state, period_start, period_end)
        VALUES (${billId}, ${params.currency}, 'OPEN', 'NOT_STARTED', ${periodStart}, ${periodEnd})
      `;

      return {
        billId,
        status: "OPEN",
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString()
      };
    });

    const persisted = await fetchBill(db, response.billId);
    if (persisted.workflow_state !== "STARTED") {
      await startBillWorkflow({
        billId: response.billId,
        currency: params.currency,
        periodStart: response.periodStart,
        periodEnd: response.periodEnd
      });
      await markBillWorkflowStarted(response.billId);
    }

    return response;
  }
);

export const addLineItem = api(
  { expose: true, auth: false, method: "POST", path: "/bills/:billId/line-items" },
  async (params: AddLineItemParams): Promise<AddLineItemResponse> => {
    const scope = `add_line_item:${params.billId}`;
    const idemKey = requireIdempotencyKey();
    const reqHash = hashRequest({ ...params });

    return executeIdempotentWorkflowWrite<AddLineItemResponse>({
      scope,
      idemKey,
      requestHash: reqHash,
      billId: params.billId,
      updateName: "addLineItem",
      args: [
        {
          requestId: idemKey,
          ...params
        }
      ],
      reconcilePending: async () => {
        return findWorkflowActivityReplay<AddLineItemResponse>(
          `workflow_add_line_item:${params.billId}`,
          idemKey,
          reqHash
        );
      }
    });
  }
);

export const workflowAddLineItem = api(
  { expose: false, auth: false, method: "POST", path: "/workflow/bills/:billId/line-items" },
  async (params: WorkflowAddLineItemParams): Promise<AddLineItemResponse> => {
    return withIdempotency<AddLineItemResponse>(
      `workflow_add_line_item:${params.billId}`,
      params.requestId,
      hashRequest({
        billId: params.billId,
        description: params.description,
        amount: params.amount,
        currency: params.currency
      }),
      async (tx) => persistAddLineItem(tx, params)
    );
  }
);

export const rejectLineItem = api(
  {
    expose: true,
    auth: false,
    method: "POST",
    path: "/bills/:billId/line-items/:lineItemId/reject"
  },
  async (params: RejectLineItemParams): Promise<RejectLineItemResponse> => {
    const scope = `reject_line_item:${params.billId}:${params.lineItemId}`;
    const idemKey = requireIdempotencyKey();
    const reqHash = hashRequest({ ...params });

    return executeIdempotentWorkflowWrite<RejectLineItemResponse>({
      scope,
      idemKey,
      requestHash: reqHash,
      billId: params.billId,
      updateName: "rejectLineItem",
      args: [
        {
          requestId: idemKey,
          ...params
        }
      ],
      reconcilePending: async () => {
        return findWorkflowActivityReplay<RejectLineItemResponse>(
          `workflow_reject_line_item:${params.billId}:${params.lineItemId}`,
          idemKey,
          reqHash
        );
      }
    });
  }
);

export const workflowRejectLineItem = api(
  {
    expose: false,
    auth: false,
    method: "POST",
    path: "/workflow/bills/:billId/line-items/:lineItemId/reject"
  },
  async (params: WorkflowRejectLineItemParams): Promise<RejectLineItemResponse> => {
    return withIdempotency<RejectLineItemResponse>(
      `workflow_reject_line_item:${params.billId}:${params.lineItemId}`,
      params.requestId,
      hashRequest({
        billId: params.billId,
        lineItemId: params.lineItemId,
        reason: params.reason
      }),
      async (tx) => persistRejectLineItem(tx, params)
    );
  }
);

export const closeBill = api(
  { expose: true, auth: false, method: "POST", path: "/bills/:billId/close" },
  async (params: CloseBillParams): Promise<CloseBillResponse> => {
    const scope = `close_bill:${params.billId}`;
    const idemKey = requireIdempotencyKey();
    const reqHash = hashRequest({ ...params });

    return executeIdempotentWorkflowWrite<CloseBillResponse>({
      scope,
      idemKey,
      requestHash: reqHash,
      billId: params.billId,
      updateName: "closeBill",
      args: [
        {
          requestId: idemKey,
          ...params
        }
      ],
      reconcilePending: async () => {
        const bill = await fetchBill(db, params.billId);
        if ((bill.status === "CLOSED" || bill.status === "COMPLETED") && bill.closed_at) {
          return buildCloseBillResponse(db, bill);
        }
        return null;
      }
    });
  }
);

export const completeBill = api(
  { expose: true, auth: false, method: "POST", path: "/bills/:billId/complete" },
  async (params: CompleteBillParams): Promise<CompleteBillResponse> => {
    const bill = await fetchBill(db, params.billId);
    if (bill.status !== "COMPLETED") {
      throw invalid(
        "BillCompletionManagedByWorkflow",
        "bill completion is managed by the workflow and happens at period end or after close"
      );
    }

    return {
      billId: bill.id,
      status: "COMPLETED",
      totalAmount: formatMinor(bill.total_minor),
      completedAt: asDate(bill.completed_at as Date | string).toISOString()
    };
  }
);

export const workflowCloseAndCompleteBill = api(
  { expose: false, auth: false, method: "POST", path: "/workflow/bills/:billId/finalize" },
  async (params: WorkflowCloseAndCompleteBillParams): Promise<{
    close: CloseBillResponse;
    complete: CompleteBillResponse;
  }> => {
    const tx = await db.begin();
    try {
      const close = await persistCloseBill(tx, params.billId);
      const complete = await persistCompleteBill(tx, params.billId);
      await tx.commit();
      return { close, complete };
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
);

export const getBill = api(
  { expose: true, auth: false, method: "GET", path: "/bills/:billId" },
  async (params: GetBillParams): Promise<BillSummary> => {
    const bill = await fetchBill(db, params.billId);
    return mapBill(bill);
  }
);

export const queryBills = api(
  { expose: true, auth: false, method: "GET", path: "/bills" },
  async ({ status }: QueryBillsParams): Promise<QueryBillsResponse> => {
    if (status !== "OPEN" && status !== "CLOSED" && status !== "COMPLETED") {
      throw invalid("InvalidStatus", "status must be OPEN, CLOSED, or COMPLETED");
    }

    const bills: BillSummary[] = [];
    const rows = db.query<BillRow>`
      SELECT id, currency, status, workflow_state, period_start, period_end, created_at, closed_at, completed_at, total_minor
      FROM bills
      WHERE status = ${status}
      ORDER BY created_at DESC
    `;
    for await (const row of rows) {
      bills.push(mapBill(row));
    }

    return { bills };
  }
);

export const getBillLineItems = api(
  { expose: true, auth: false, method: "GET", path: "/bills/:billId/line-items" },
  async (params: GetLineItemsParams): Promise<GetLineItemsResponse> => {
    await assertBillExists(params.billId);
    const rows = db.query<LineItemRow>`
      SELECT id, bill_id, description, amount_minor, currency, status, rejection_reason, created_at, rejected_at
      FROM bill_line_items
      WHERE bill_id = ${params.billId}
      ORDER BY created_at ASC
    `;

    const items: LineItem[] = [];
    for await (const row of rows) {
      items.push({
        id: row.id,
        billId: row.bill_id,
        description: row.description,
        amount: formatMinor(row.amount_minor),
        currency: row.currency,
        status: row.status,
        reason: row.rejection_reason,
        createdAt: asDate(row.created_at).toISOString(),
        rejectedAt: row.rejected_at ? asDate(row.rejected_at).toISOString() : null
      });
    }

    return { items };
  }
);

export const getInvoice = api(
  { expose: true, auth: false, method: "GET", path: "/bills/:billId/invoice" },
  async (params: GetLineItemsParams): Promise<InvoiceResponse> => {
    const bill = await fetchBill(db, params.billId);
    if (bill.status !== "COMPLETED") {
      throw invalid("BillNotCompleted", "invoice is available only for completed bills");
    }

    const rows = db.query<LineItemRow>`
      SELECT id, description, amount_minor, currency, status, created_at, bill_id, rejection_reason, rejected_at
      FROM bill_line_items
      WHERE bill_id = ${params.billId} AND status = 'ADDED'
      ORDER BY created_at ASC
    `;

    const lineItems: InvoiceResponse["lineItems"] = [];
    for await (const row of rows) {
      lineItems.push({
        id: row.id,
        description: row.description,
        amount: formatMinor(row.amount_minor),
        currency: row.currency,
        createdAt: asDate(row.created_at).toISOString()
      });
    }

    return {
      billId: bill.id,
      status: "COMPLETED",
      currency: bill.currency,
      totalAmount: formatMinor(bill.total_minor),
      lineItems
    };
  }
);

export const liveness = api(
  { expose: true, auth: false, method: "GET", path: "/livez" },
  async (): Promise<LivenessResponse> => ({
    ok: true,
    service: "backend"
  })
);

export const health = api(
  { expose: true, auth: false, method: "GET", path: "/readyz" },
  async (): Promise<HealthResponse> => {
    const dbCheck = await db.queryRow<{ ok: number }>`SELECT 1 AS ok`;
    if (!dbCheck || Number(dbCheck.ok) !== 1) {
      throw APIError.unavailable("database health check failed");
    }

    return {
      ok: true,
      service: "backend",
      checks: {
        database: "ok"
      }
    };
  }
);

async function withIdempotency<T>(
  scope: string,
  idemKey: string,
  requestHash: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  const tx = await db.begin();
  try {
    const existing = await tx.queryRow<IdempotencyRow>`
      SELECT request_hash, response_json, state
      FROM idempotency_records
      WHERE scope = ${scope} AND idem_key = ${idemKey}
    `;

    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw conflict("IdempotencyKeyConflict", "idempotency key reused with different payload");
      }

      if (existing.state === "PENDING" || existing.response_json === null) {
        await tx.rollback();
        throw APIError.unavailable("request is still in progress");
      }

      await tx.rollback();
      return existing.response_json as T;
    }

    const response = await fn(tx);

    await tx.exec`
      INSERT INTO idempotency_records (scope, idem_key, request_hash, state, response_json, http_code)
      VALUES (${scope}, ${idemKey}, ${requestHash}, 'COMPLETED', ${response as object}, 200)
    `;

    await tx.commit();
    return response;
  } catch (err) {
    if (isUniqueViolation(err)) {
      await tx.rollback();
      const current = await db.queryRow<IdempotencyRow>`
        SELECT request_hash, response_json, state
        FROM idempotency_records
        WHERE scope = ${scope} AND idem_key = ${idemKey}
      `;
      if (
        current &&
        current.request_hash === requestHash &&
        current.state === "COMPLETED" &&
        current.response_json !== null
      ) {
        return current.response_json as T;
      }
      throw conflict("IdempotencyKeyConflict", "idempotency key reused with different payload");
    }

    await tx.rollback();
    throw err;
  }
}

async function executeIdempotentWorkflowWrite<T extends object>(options: {
  scope: string;
  idemKey: string;
  requestHash: string;
  billId: string;
  updateName: string;
  args: [unknown, ...unknown[]];
  reconcilePending: () => Promise<T | null>;
}): Promise<T> {
  const reservation = await reservePendingIdempotency<T>(
    options.scope,
    options.idemKey,
    options.requestHash
  );
  if (reservation.kind === "completed") {
    return reservation.response;
  }

  if (reservation.kind === "existing-pending") {
    const reconciled = await options.reconcilePending();
    if (reconciled) {
      await completePendingIdempotency(
        options.scope,
        options.idemKey,
        options.requestHash,
        reconciled
      );
      return reconciled;
    }
  }

  const response = await executeBillWorkflowUpdate<T>(
    options.updateName,
    options.billId,
    options.args
  );
  await completePendingIdempotency(
    options.scope,
    options.idemKey,
    options.requestHash,
    response
  );
  return response;
}

async function reservePendingIdempotency<T>(
  scope: string,
  idemKey: string,
  requestHash: string
): Promise<
  { kind: "created-pending" } | { kind: "existing-pending" } | { kind: "completed"; response: T }
> {
  const tx = await db.begin();
  try {
    const existing = await tx.queryRow<IdempotencyRow>`
      SELECT request_hash, response_json, state
      FROM idempotency_records
      WHERE scope = ${scope} AND idem_key = ${idemKey}
    `;

    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw conflict("IdempotencyKeyConflict", "idempotency key reused with different payload");
      }

      await tx.rollback();
      if (existing.state === "COMPLETED" && existing.response_json !== null) {
        return { kind: "completed", response: existing.response_json as T };
      }
      return { kind: "existing-pending" };
    }

    await tx.exec`
      INSERT INTO idempotency_records (scope, idem_key, request_hash, state)
      VALUES (${scope}, ${idemKey}, ${requestHash}, 'PENDING')
    `;
    await tx.commit();
    return { kind: "created-pending" };
  } catch (err) {
    if (isUniqueViolation(err)) {
      await tx.rollback();
      const current = await db.queryRow<IdempotencyRow>`
        SELECT request_hash, response_json, state
        FROM idempotency_records
        WHERE scope = ${scope} AND idem_key = ${idemKey}
      `;
      if (!current || current.request_hash !== requestHash) {
        throw conflict("IdempotencyKeyConflict", "idempotency key reused with different payload");
      }
      if (current.state === "COMPLETED" && current.response_json !== null) {
        return { kind: "completed", response: current.response_json as T };
      }
      return { kind: "existing-pending" };
    }

    await tx.rollback();
    throw err;
  }
}

async function completePendingIdempotency<T extends object>(
  scope: string,
  idemKey: string,
  requestHash: string,
  response: T
): Promise<void> {
  await db.exec`
    UPDATE idempotency_records
    SET state = 'COMPLETED', response_json = ${response as object}, http_code = 200, updated_at = now()
    WHERE scope = ${scope} AND idem_key = ${idemKey} AND request_hash = ${requestHash}
  `;
}

async function findWorkflowActivityReplay<T>(
  scope: string,
  idemKey: string,
  requestHash: string
): Promise<T | null> {
  const row = await db.queryRow<IdempotencyRow>`
    SELECT request_hash, response_json, state
    FROM idempotency_records
    WHERE scope = ${scope} AND idem_key = ${idemKey}
  `;

  if (!row) {
    return null;
  }
  if (row.request_hash !== requestHash) {
    throw conflict("IdempotencyKeyConflict", "idempotency key reused with different payload");
  }
  if (row.state === "COMPLETED" && row.response_json !== null) {
    return row.response_json as T;
  }
  return null;
}

async function fetchBill(executor: QueryExecutor, billId: string): Promise<BillRow> {
  const bill = await executor.queryRow<BillRow>`
    SELECT id, currency, status, workflow_state, period_start, period_end, created_at, closed_at, completed_at, total_minor
    FROM bills
    WHERE id = ${billId}
  `;

  if (!bill) {
    throw APIError.notFound("BillNotFound").withDetails({ code: "BillNotFound" });
  }

  return bill;
}

async function fetchBillForUpdate(tx: Tx, billId: string): Promise<BillRow> {
  const bill = await tx.queryRow<BillRow>`
    SELECT id, currency, status, workflow_state, period_start, period_end, created_at, closed_at, completed_at, total_minor
    FROM bills
    WHERE id = ${billId}
    FOR UPDATE
  `;

  if (!bill) {
    throw APIError.notFound("BillNotFound").withDetails({ code: "BillNotFound" });
  }

  return bill;
}

async function persistAddLineItem(
  tx: Tx,
  params: WorkflowAddLineItemParams
): Promise<AddLineItemResponse> {
  const bill = await fetchBillForUpdate(tx, params.billId);
  if (bill.status !== "OPEN") {
    throw invalid("BillNotOpen", "line item additions are allowed only for OPEN bills");
  }

  validateCurrency(params.currency);
  if (bill.currency !== params.currency) {
    throw invalid("CurrencyMismatch", "line item currency must match bill currency");
  }

  const description = normalizeText(params.description, "description");
  const amountMinor = parseAmountToMinor(params.amount);
  const lineItemId = uuidv7();

  const inserted = await tx.queryRow<{ created_at: Date | string }>`
    INSERT INTO bill_line_items (id, bill_id, description, amount_minor, currency, status)
    VALUES (${lineItemId}, ${params.billId}, ${description}, ${amountMinor}, ${params.currency}, 'ADDED')
    RETURNING created_at
  `;

  if (!inserted) {
    throw APIError.internal("failed to create line item");
  }

  return {
    lineItemId,
    billId: params.billId,
    description,
    amount: formatMinor(amountMinor),
    status: "ADDED",
    createdAt: asDate(inserted.created_at).toISOString()
  };
}

async function persistRejectLineItem(
  tx: Tx,
  params: WorkflowRejectLineItemParams
): Promise<RejectLineItemResponse> {
  const bill = await fetchBillForUpdate(tx, params.billId);
  if (bill.status !== "OPEN") {
    throw invalid("BillNotOpen", "line item rejection is allowed only for OPEN bills");
  }

  const reason = normalizeText(params.reason, "reason");
  const lineItem = await fetchLineItemForUpdate(tx, params.billId, params.lineItemId);
  if (lineItem.status === "REJECTED") {
    throw invalid("LineItemAlreadyRejected", "rejected item cannot change status");
  }

  const updated = await tx.queryRow<{ rejected_at: Date | string }>`
    UPDATE bill_line_items
    SET status = 'REJECTED', rejected_at = now(), rejection_reason = ${reason}
    WHERE id = ${params.lineItemId} AND bill_id = ${params.billId}
    RETURNING rejected_at
  `;

  if (!updated) {
    throw APIError.internal("failed to reject line item");
  }

  return {
    lineItemId: params.lineItemId,
    billId: params.billId,
    status: "REJECTED",
    rejectedAt: asDate(updated.rejected_at).toISOString(),
    reason
  };
}

async function persistCloseBill(tx: Tx, billId: string): Promise<CloseBillResponse> {
  const bill = await fetchBillForUpdate(tx, billId);

  if (bill.status === "OPEN") {
    const updated = await tx.queryRow<{ closed_at: Date | string }>`
      UPDATE bills
      SET status = 'CLOSED', closed_at = now()
      WHERE id = ${billId}
      RETURNING closed_at
    `;

    if (!updated) {
      throw APIError.internal("failed to close bill");
    }

    return buildCloseBillResponse(tx, {
      ...bill,
      status: "CLOSED",
      closed_at: updated.closed_at
    });
  }

  if ((bill.status === "CLOSED" || bill.status === "COMPLETED") && bill.closed_at) {
    return buildCloseBillResponse(tx, bill);
  }

  throw invalid("BillNotOpen", "only OPEN bills can be closed");
}

async function buildCloseBillResponse(
  executor: BillReadExecutor,
  bill: Pick<BillRow, "id" | "currency" | "closed_at" | "status" | "total_minor">
): Promise<CloseBillResponse> {
  const lineItems = await listChargeableLineItems(executor, bill.id);
  const totalMinor = bill.status === "COMPLETED"
    ? toBigInt(bill.total_minor)
    : lineItems.reduce((sum, item) => sum + toBigInt(item.amount_minor), 0n);

  return {
    billId: bill.id,
    status: "CLOSED",
    closedAt: asDate(bill.closed_at as Date | string).toISOString(),
    totalAmount: formatMinor(totalMinor),
    lineItems: lineItems.map((item) => ({
      id: item.id,
      description: item.description,
      amount: formatMinor(item.amount_minor),
      currency: item.currency,
      createdAt: asDate(item.created_at).toISOString()
    }))
  };
}

async function listChargeableLineItems(
  executor: BillReadExecutor,
  billId: string
): Promise<Array<Pick<LineItemRow, "id" | "description" | "amount_minor" | "currency" | "created_at">>> {
  const rows = executor.query<LineItemRow>`
    SELECT id, description, amount_minor, currency, created_at, bill_id, status, rejection_reason, rejected_at
    FROM bill_line_items
    WHERE bill_id = ${billId} AND status = 'ADDED'
    ORDER BY created_at ASC
  `;

  const items: Array<
    Pick<LineItemRow, "id" | "description" | "amount_minor" | "currency" | "created_at">
  > = [];
  for await (const row of rows) {
    items.push({
      id: row.id,
      description: row.description,
      amount_minor: row.amount_minor,
      currency: row.currency,
      created_at: row.created_at
    });
  }
  return items;
}

async function persistCompleteBill(tx: Tx, billId: string): Promise<CompleteBillResponse> {
  const bill = await fetchBillForUpdate(tx, billId);

  if (bill.status === "COMPLETED" && bill.completed_at) {
    return {
      billId,
      status: "COMPLETED",
      totalAmount: formatMinor(bill.total_minor),
      completedAt: asDate(bill.completed_at).toISOString()
    };
  }

  if (bill.status !== "CLOSED") {
    throw invalid("BillNotClosed", "only CLOSED bills can be completed");
  }

  const totalRow = await tx.queryRow<{ total_minor: string | number | bigint }>`
    SELECT COALESCE(SUM(amount_minor), 0) AS total_minor
    FROM bill_line_items
    WHERE bill_id = ${billId} AND status = 'ADDED'
  `;
  const totalMinor = BigInt(totalRow ? totalRow.total_minor : 0);

  const updated = await tx.queryRow<{ completed_at: Date | string }>`
    UPDATE bills
    SET status = 'COMPLETED', completed_at = now(), total_minor = ${totalMinor}
    WHERE id = ${billId}
    RETURNING completed_at
  `;

  if (!updated) {
    throw APIError.internal("failed to complete bill");
  }

  return {
    billId,
    status: "COMPLETED",
    totalAmount: formatMinor(totalMinor),
    completedAt: asDate(updated.completed_at).toISOString()
  };
}

async function fetchLineItemForUpdate(
  tx: Tx,
  billId: string,
  lineItemId: string
): Promise<LineItemRow> {
  const lineItem = await tx.queryRow<LineItemRow>`
    SELECT id, bill_id, description, amount_minor, currency, status, rejection_reason, created_at, rejected_at
    FROM bill_line_items
    WHERE id = ${lineItemId} AND bill_id = ${billId}
    FOR UPDATE
  `;

  if (!lineItem) {
    throw APIError.notFound("LineItemNotFound").withDetails({ code: "LineItemNotFound" });
  }

  return lineItem;
}

async function assertBillExists(billId: string): Promise<void> {
  const row = await db.queryRow<{ id: string }>`SELECT id FROM bills WHERE id = ${billId}`;
  if (!row) {
    throw APIError.notFound("BillNotFound").withDetails({ code: "BillNotFound" });
  }
}

async function markBillWorkflowStarted(billId: string): Promise<void> {
  await db.exec`
    UPDATE bills
    SET workflow_state = 'STARTED'
    WHERE id = ${billId} AND workflow_state <> 'STARTED'
  `;
}

function requireIdempotencyKey(): string {
  const req = currentRequest();
  const nodeEnv = process.env.NODE_ENV ?? "production";

  if (!req || req.type !== "api-call") {
    if (nodeEnv === "test") {
      const forced = process.env.TEST_IDEMPOTENCY_KEY?.trim();
      if (forced) {
        return forced;
      }
      return `test-${uuidv7()}`;
    }
    throw invalid("MissingIdempotencyKey", "Idempotency-Key header is required");
  }

  const raw = req.headers["idempotency-key"] ?? req.headers["Idempotency-Key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || !key.trim()) {
    throw invalid("MissingIdempotencyKey", "Idempotency-Key header is required");
  }

  return key.trim();
}

function hashRequest(input: unknown): string {
  const normalized = stableStringify(input);
  return createHash("sha256").update(normalized).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

function parseDate(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw invalid("InvalidDate", `${field} must be a valid ISO-8601 date`);
  }
  return d;
}

function parseAmountToMinor(input: string): bigint {
  if (typeof input !== "string") {
    throw invalid("InvalidAmount", "amount must be a decimal string");
  }

  const value = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw invalid("InvalidAmount", "amount must be a positive decimal with max 2 digits");
  }

  const [wholePart, fractionPartRaw] = value.split(".");
  const fractionPart = (fractionPartRaw ?? "").padEnd(2, "0");
  const whole = BigInt(wholePart);
  const fraction = BigInt(fractionPart || "00");
  const minor = whole * 100n + fraction;

  if (minor <= 0n) {
    throw invalid("InvalidAmount", "amount must be greater than zero");
  }

  return minor;
}

function normalizeText(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw invalid(`Invalid${capitalize(field)}`, `${field} is required`);
  }
  return normalized;
}

function formatMinor(amount: string | number | bigint): string {
  const minor = toBigInt(amount);
  const abs = minor < 0n ? -minor : minor;
  const cents = (abs % 100n).toString().padStart(2, "0");
  const units = (abs / 100n).toString();
  return `${minor < 0n ? "-" : ""}${units}.${cents}`;
}

function toBigInt(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value);
}

function validateCurrency(currency: string): asserts currency is Currency {
  if (currency !== "USD" && currency !== "GEL") {
    throw invalid("InvalidCurrency", "currency must be USD or GEL");
  }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapBill(row: BillRow): BillSummary {
  return {
    billId: row.id,
    status: row.status,
    currency: row.currency,
    periodStart: asDate(row.period_start).toISOString(),
    periodEnd: asDate(row.period_end).toISOString(),
    createdAt: asDate(row.created_at).toISOString(),
    closedAt: row.closed_at ? asDate(row.closed_at).toISOString() : null,
    completedAt: row.completed_at ? asDate(row.completed_at).toISOString() : null,
    totalAmount: formatMinor(row.total_minor)
  };
}

function invalid(code: string, message: string): APIError {
  return APIError.invalidArgument(message).withDetails({ code });
}

function conflict(code: string, message: string): APIError {
  return APIError.aborted(message).withDetails({ code });
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const maybeCode = (err as { code?: string }).code;
  return maybeCode === "23505";
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

function workflowIdForBill(billId: string): string {
  return `bill/${billId}`;
}

function temporalTaskQueue(): string {
  return process.env.TEMPORAL_TASK_QUEUE?.trim() || "billing-periods";
}

function temporalAddress(): string {
  return process.env.TEMPORAL_ADDRESS?.trim() || "localhost:7233";
}

function temporalApiKey(): string | undefined {
  const value = process.env.TEMPORAL_API_KEY?.trim();
  return value ? value : undefined;
}

async function getTemporalConnection(): Promise<TemporalConnection> {
  const apiKey = temporalApiKey();
  temporalConnectionPromise ??= TemporalConnection.connect({
    address: temporalAddress(),
    apiKey,
    tls: apiKey ? true : undefined
  });
  return temporalConnectionPromise;
}

async function getTemporalClient(): Promise<TemporalClient> {
  temporalClientPromise ??= getTemporalConnection().then(
    (connection) =>
      new TemporalClient({
        connection,
        namespace: process.env.TEMPORAL_NAMESPACE?.trim() || "default"
      })
  );
  return temporalClientPromise;
}

async function startBillWorkflow(input: {
  billId: string;
  currency: Currency;
  periodStart: string;
  periodEnd: string;
}): Promise<void> {
  try {
    const client = await getTemporalClient();
    await client.workflow.start("billPeriodWorkflow", {
      taskQueue: temporalTaskQueue(),
      workflowId: workflowIdForBill(input.billId),
      args: [input]
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      return;
    }
    throw mapTemporalError(error);
  }
}

async function executeBillWorkflowUpdate<T>(
  updateName: string,
  billId: string,
  args: [unknown, ...unknown[]]
): Promise<T> {
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowIdForBill(billId));
    return await handle.executeUpdate<T, [unknown, ...unknown[]]>(updateName, { args });
  } catch (error) {
    throw mapTemporalError(error);
  }
}

function mapTemporalError(error: unknown): APIError {
  if (error instanceof WorkflowUpdateFailedError && error.cause instanceof ApplicationFailure) {
    const detail = error.cause.details?.[0];
    const code =
      detail && typeof detail === "object" && "code" in detail ? String(detail.code) : undefined;
    const message = error.cause.message || "workflow update failed";

    if (code && code.endsWith("NotFound")) {
      return APIError.notFound(message).withDetails({ code });
    }

    if (code && code.includes("Conflict")) {
      return conflict(code, message);
    }

    return invalid(code ?? "WorkflowUpdateRejected", message);
  }

  if (error instanceof WorkflowUpdateRPCTimeoutOrCancelledError) {
    return APIError.unavailable("workflow update timed out");
  }

  if (error instanceof WorkflowExecutionAlreadyStartedError) {
    return conflict("WorkflowAlreadyStarted", error.message);
  }

  return APIError.unavailable("workflow service unavailable");
}
