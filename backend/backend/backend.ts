import { api, APIError } from "encore.dev/api";
import { currentRequest } from "encore.dev";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";

const db = new SQLDatabase("backend", { migrations: "./migrations" });
type Tx = Awaited<ReturnType<SQLDatabase["begin"]>>;

type BillStatus = "OPEN" | "CLOSED" | "COMPLETED";
type LineItemStatus = "ADDED" | "REJECTED";
type Currency = "USD" | "GEL";

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
}

interface CompleteBillParams {
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
  response_json: unknown;
}

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

    return withIdempotency(scope, idemKey, reqHash, async (tx) => {
      const billId = uuidv7();
      await tx.exec`
        INSERT INTO bills (id, currency, status, period_start, period_end)
        VALUES (${billId}, ${params.currency}, 'OPEN', ${periodStart}, ${periodEnd})
      `;

      return {
        billId,
        status: "OPEN",
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString()
      };
    });
  }
);

export const addLineItem = api(
  { expose: true, auth: false, method: "POST", path: "/bills/:billId/line-items" },
  async (params: AddLineItemParams): Promise<AddLineItemResponse> => {
    const scope = `add_line_item:${params.billId}`;
    const idemKey = requireIdempotencyKey();
    const reqHash = hashRequest({ ...params });

    return withIdempotency(scope, idemKey, reqHash, async (tx) => {
      const bill = await fetchBillForUpdate(tx, params.billId);
      if (bill.status !== "OPEN") {
        throw invalid("BillNotOpen", "line item additions are allowed only for OPEN bills");
      }

      validateCurrency(params.currency);
      if (bill.currency !== params.currency) {
        throw invalid("CurrencyMismatch", "line item currency must match bill currency");
      }

      const description = params.description?.trim();
      if (!description) {
        throw invalid("InvalidDescription", "description is required");
      }

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
    });
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

    return withIdempotency(scope, idemKey, reqHash, async (tx) => {
      const bill = await fetchBillForUpdate(tx, params.billId);
      if (bill.status !== "OPEN") {
        throw invalid("BillNotOpen", "line item rejection is allowed only for OPEN bills");
      }

      const reason = params.reason?.trim();
      if (!reason) {
        throw invalid("InvalidRejectionReason", "reason is required");
      }

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
    });
  }
);

export const closeBill = api(
  { expose: true, auth: false, method: "POST", path: "/bills/:billId/close" },
  async (params: CloseBillParams): Promise<CloseBillResponse> => {
    const scope = `close_bill:${params.billId}`;
    const idemKey = requireIdempotencyKey();
    const reqHash = hashRequest({ ...params });

    return withIdempotency(scope, idemKey, reqHash, async (tx) => {
      const bill = await fetchBillForUpdate(tx, params.billId);
      if (bill.status !== "OPEN") {
        throw invalid("BillNotOpen", "only OPEN bills can be closed");
      }

      const updated = await tx.queryRow<{ closed_at: Date | string }>`
        UPDATE bills
        SET status = 'CLOSED', closed_at = now()
        WHERE id = ${params.billId}
        RETURNING closed_at
      `;

      if (!updated) {
        throw APIError.internal("failed to close bill");
      }

      return {
        billId: params.billId,
        status: "CLOSED",
        closedAt: asDate(updated.closed_at).toISOString()
      };
    });
  }
);

export const completeBill = api(
  { expose: true, auth: false, method: "POST", path: "/bills/:billId/complete" },
  async (params: CompleteBillParams): Promise<CompleteBillResponse> => {
    const scope = `complete_bill:${params.billId}`;
    const idemKey = requireIdempotencyKey();
    const reqHash = hashRequest({ ...params });

    return withIdempotency(scope, idemKey, reqHash, async (tx) => {
      const bill = await fetchBillForUpdate(tx, params.billId);
      if (bill.status === "COMPLETED") {
        throw invalid("BillAlreadyCompleted", "bill is already completed");
      }
      if (bill.status !== "CLOSED") {
        throw invalid("BillNotClosed", "only CLOSED bills can be completed");
      }

      const totalRow = await tx.queryRow<{ total_minor: string | number | bigint }>`
        SELECT COALESCE(SUM(amount_minor), 0) AS total_minor
        FROM bill_line_items
        WHERE bill_id = ${params.billId} AND status = 'ADDED'
      `;
      const totalMinor = totalRow ? totalRow.total_minor : 0;

      const updated = await tx.queryRow<{ completed_at: Date | string }>`
        UPDATE bills
        SET status = 'COMPLETED', completed_at = now(), total_minor = ${totalMinor}
        WHERE id = ${params.billId}
        RETURNING completed_at
      `;

      if (!updated) {
        throw APIError.internal("failed to complete bill");
      }

      return {
        billId: params.billId,
        status: "COMPLETED",
        totalAmount: formatMinor(totalMinor),
        completedAt: asDate(updated.completed_at).toISOString()
      };
    });
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
      SELECT id, currency, status, period_start, period_end, created_at, closed_at, completed_at, total_minor
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
  { expose: true, auth: false, method: "GET", path: "/healthz" },
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
      SELECT request_hash, response_json
      FROM idempotency_records
      WHERE scope = ${scope} AND idem_key = ${idemKey}
    `;

    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw conflict("IdempotencyKeyConflict", "idempotency key reused with different payload");
      }

      await tx.rollback();
      return existing.response_json as T;
    }

    const response = await fn(tx);

    await tx.exec`
      INSERT INTO idempotency_records (scope, idem_key, request_hash, response_json, http_code)
      VALUES (${scope}, ${idemKey}, ${requestHash}, ${response as object}, 200)
    `;

    await tx.commit();
    return response;
  } catch (err) {
    if (isUniqueViolation(err)) {
      await tx.rollback();
      const current = await db.queryRow<IdempotencyRow>`
        SELECT request_hash, response_json
        FROM idempotency_records
        WHERE scope = ${scope} AND idem_key = ${idemKey}
      `;
      if (current && current.request_hash === requestHash) {
        return current.response_json as T;
      }
      throw conflict("IdempotencyKeyConflict", "idempotency key reused with different payload");
    }

    await tx.rollback();
    throw err;
  }
}

async function fetchBill(executor: SQLDatabase | Tx, billId: string): Promise<BillRow> {
  const bill = await executor.queryRow<BillRow>`
    SELECT id, currency, status, period_start, period_end, created_at, closed_at, completed_at, total_minor
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
    SELECT id, currency, status, period_start, period_end, created_at, closed_at, completed_at, total_minor
    FROM bills
    WHERE id = ${billId}
    FOR UPDATE
  `;

  if (!bill) {
    throw APIError.notFound("BillNotFound").withDetails({ code: "BillNotFound" });
  }

  return bill;
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
