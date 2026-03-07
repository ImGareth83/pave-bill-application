import { v7 as uuidv7 } from "uuid";

import { withTransaction, queryOne, type Tx } from "../db";
import {
  asDate,
  formatMinor,
  normalizeText,
  parseAmountToMinor,
  validateCurrency
} from "../domain";
import { conflict, invalid, isUniqueViolation, notFound } from "../errors";
import { hashRequest } from "../idempotency";
import type {
  AddLineItemInput,
  AddLineItemResponse,
  BillRow,
  CloseBillInput,
  CloseBillResponse,
  CompleteBillInput,
  CompleteBillResponse,
  IdempotencyRow,
  LineItemRow,
  PersistedLifecycleResult,
  RejectLineItemInput,
  RejectLineItemResponse
} from "../types";

export const billActivities = {
  addLineItem,
  rejectLineItem,
  closeBill,
  completeBill,
  closeAndCompleteBill
};

export async function addLineItem(input: AddLineItemInput): Promise<AddLineItemResponse> {
  return withTransaction(async (client) => {
    const scope = `workflow_add_line_item:${input.billId}`;
    const requestHash = hashRequest({
      billId: input.billId,
      description: input.description,
      amount: input.amount,
      currency: input.currency
    });

    const existing = await findIdempotentResponse<AddLineItemResponse>(
      client,
      scope,
      input.requestId,
      requestHash
    );
    if (existing) {
      return existing;
    }

    const bill = await fetchBillForUpdate(client, input.billId);
    if (bill.status !== "OPEN") {
      invalid("BillNotOpen", "line item additions are allowed only for OPEN bills");
    }

    validateCurrency(input.currency);
    if (bill.currency !== input.currency) {
      invalid("CurrencyMismatch", "line item currency must match bill currency");
    }

    const description = normalizeText(input.description, "description");
    const amountMinor = parseAmountToMinor(input.amount);
    const lineItemId = uuidv7();

    const inserted = await queryOne<{ created_at: Date | string }>(
      client,
      `
        INSERT INTO bill_line_items (id, bill_id, description, amount_minor, currency, status)
        VALUES ($1, $2, $3, $4, $5, 'ADDED')
        RETURNING created_at
      `,
      [lineItemId, input.billId, description, amountMinor, input.currency]
    );

    if (!inserted) {
      throw new Error("failed to create line item");
    }

    const response: AddLineItemResponse = {
      lineItemId,
      billId: input.billId,
      description,
      amount: formatMinor(amountMinor),
      status: "ADDED",
      createdAt: asDate(inserted.created_at).toISOString()
    };

    return storeIdempotentResponse(client, scope, input.requestId, requestHash, response);
  });
}

export async function rejectLineItem(input: RejectLineItemInput): Promise<RejectLineItemResponse> {
  return withTransaction(async (client) => {
    const scope = `workflow_reject_line_item:${input.billId}:${input.lineItemId}`;
    const requestHash = hashRequest({
      billId: input.billId,
      lineItemId: input.lineItemId,
      reason: input.reason
    });

    const existing = await findIdempotentResponse<RejectLineItemResponse>(
      client,
      scope,
      input.requestId,
      requestHash
    );
    if (existing) {
      return existing;
    }

    const bill = await fetchBillForUpdate(client, input.billId);
    if (bill.status !== "OPEN") {
      invalid("BillNotOpen", "line item rejection is allowed only for OPEN bills");
    }

    const reason = normalizeText(input.reason, "reason");
    const lineItem = await fetchLineItemForUpdate(client, input.billId, input.lineItemId);
    if (lineItem.status === "REJECTED") {
      invalid("LineItemAlreadyRejected", "rejected item cannot change status");
    }

    const updated = await queryOne<{ rejected_at: Date | string }>(
      client,
      `
        UPDATE bill_line_items
        SET status = 'REJECTED', rejected_at = now(), rejection_reason = $1
        WHERE id = $2 AND bill_id = $3
        RETURNING rejected_at
      `,
      [reason, input.lineItemId, input.billId]
    );

    if (!updated) {
      throw new Error("failed to reject line item");
    }

    const response: RejectLineItemResponse = {
      lineItemId: input.lineItemId,
      billId: input.billId,
      status: "REJECTED",
      rejectedAt: asDate(updated.rejected_at).toISOString(),
      reason
    };

    return storeIdempotentResponse(client, scope, input.requestId, requestHash, response);
  });
}

export async function closeBill(input: CloseBillInput): Promise<CloseBillResponse> {
  return withTransaction(async (client) => {
    return persistCloseBill(client, input.billId);
  });
}

export async function completeBill(input: CompleteBillInput): Promise<CompleteBillResponse> {
  return withTransaction(async (client) => {
    return persistCompleteBill(client, input.billId);
  });
}

export async function closeAndCompleteBill(billId: string): Promise<PersistedLifecycleResult> {
  return withTransaction(async (client) => {
    const close = await persistCloseBill(client, billId);
    const complete = await persistCompleteBill(client, billId);
    return { close, complete };
  });
}

async function fetchBillForUpdate(
  client: Tx,
  billId: string
): Promise<BillRow> {
  const bill = await queryOne<BillRow>(
    client,
    `
      SELECT id, currency, status, workflow_state, period_start, period_end, created_at, closed_at, completed_at, total_minor
      FROM bills
      WHERE id = $1
      FOR UPDATE
    `,
    [billId]
  );

  if (!bill) {
    notFound("BillNotFound", "bill not found");
  }

  return bill;
}

async function fetchLineItemForUpdate(
  client: Tx,
  billId: string,
  lineItemId: string
): Promise<LineItemRow> {
  const lineItem = await queryOne<LineItemRow>(
    client,
    `
      SELECT id, bill_id, description, amount_minor, currency, status, rejection_reason, created_at, rejected_at
      FROM bill_line_items
      WHERE id = $1 AND bill_id = $2
      FOR UPDATE
    `,
    [lineItemId, billId]
  );

  if (!lineItem) {
    notFound("LineItemNotFound", "line item not found");
  }

  return lineItem;
}

async function persistCloseBill(client: Tx, billId: string): Promise<CloseBillResponse> {
  const bill = await fetchBillForUpdate(client, billId);

  if (bill.status === "OPEN") {
    const updated = await queryOne<{ closed_at: Date | string }>(
      client,
      `
        UPDATE bills
        SET status = 'CLOSED', closed_at = now()
        WHERE id = $1
        RETURNING closed_at
      `,
      [billId]
    );

    if (!updated) {
      throw new Error("failed to close bill");
    }

    return {
      billId,
      status: "CLOSED",
      closedAt: asDate(updated.closed_at).toISOString()
    };
  }

  if ((bill.status === "CLOSED" || bill.status === "COMPLETED") && bill.closed_at) {
    return {
      billId,
      status: "CLOSED",
      closedAt: asDate(bill.closed_at).toISOString()
    };
  }

  invalid("BillNotOpen", "only OPEN bills can be closed");
}

async function persistCompleteBill(
  client: Tx,
  billId: string
): Promise<CompleteBillResponse> {
  const bill = await fetchBillForUpdate(client, billId);

  if (bill.status === "COMPLETED" && bill.completed_at) {
    return {
      billId,
      status: "COMPLETED",
      totalAmount: formatMinor(bill.total_minor),
      completedAt: asDate(bill.completed_at).toISOString()
    };
  }

  if (bill.status !== "CLOSED") {
    invalid("BillNotClosed", "only CLOSED bills can be completed");
  }

  const totalRow = await queryOne<{ total_minor: string | number | bigint }>(
    client,
    `
      SELECT COALESCE(SUM(amount_minor), 0) AS total_minor
      FROM bill_line_items
      WHERE bill_id = $1 AND status = 'ADDED'
    `,
    [billId]
  );
  const totalMinor = BigInt(totalRow ? totalRow.total_minor : 0);

  const updated = await queryOne<{ completed_at: Date | string }>(
    client,
    `
      UPDATE bills
      SET status = 'COMPLETED', completed_at = now(), total_minor = $2
      WHERE id = $1
      RETURNING completed_at
    `,
      [billId, totalMinor]
  );

  if (!updated) {
    throw new Error("failed to complete bill");
  }

  return {
    billId,
    status: "COMPLETED",
    totalAmount: formatMinor(totalMinor),
    completedAt: asDate(updated.completed_at).toISOString()
  };
}

async function findIdempotentResponse<T>(
  client: Tx,
  scope: string,
  requestId: string,
  requestHash: string
): Promise<T | null> {
  const row = await queryOne<IdempotencyRow>(
    client,
    `
      SELECT request_hash, response_json
      FROM idempotency_records
      WHERE scope = $1 AND idem_key = $2
    `,
    [scope, requestId]
  );

  if (!row) {
    return null;
  }

  if (row.request_hash !== requestHash) {
    conflict("IdempotencyKeyConflict", "idempotency key reused with different payload");
  }

  return row.response_json as T;
}

async function storeIdempotentResponse<T extends object>(
  client: Tx,
  scope: string,
  requestId: string,
  requestHash: string,
  response: T
): Promise<T> {
  try {
    await client.query(
      `
        INSERT INTO idempotency_records (scope, idem_key, request_hash, response_json, http_code)
        VALUES ($1, $2, $3, $4, 200)
      `,
      [scope, requestId, requestHash, response as object]
    );
    return response;
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    const existing = await findIdempotentResponse<T>(client, scope, requestId, requestHash);
    if (existing) {
      return existing;
    }

    conflict("IdempotencyKeyConflict", "idempotency key reused with different payload");
  }
}
