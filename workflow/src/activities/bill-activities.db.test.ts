import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { v7 as uuidv7 } from "uuid";

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL?.trim());
const describeDb = hasDatabaseUrl ? describe.sequential : describe.skip;

describeDb("bill activities database integration", () => {
  let dbModule: typeof import("../db");
  let activityModule: typeof import("./bill-activities");

  beforeAll(async () => {
    dbModule = await import("../db");
    activityModule = await import("./bill-activities");
  });

  afterEach(async () => {
    await dbModule.db.rawExec(
      `
        DELETE FROM idempotency_records
        WHERE idem_key LIKE 'itest-%'
           OR scope LIKE 'workflow\\_%itest-%' ESCAPE '\\'
      `
    );
    await dbModule.db.rawExec(
      `
        DELETE FROM bill_line_items
        WHERE bill_id LIKE 'itest-%'
           OR id LIKE 'itest-%'
      `
    );
    await dbModule.db.rawExec(
      `
        DELETE FROM bills
        WHERE id LIKE 'itest-%'
      `
    );
  });

  test("addLineItem persists once and replays the stored response for the same request", async () => {
    const billId = `itest-bill-${uuidv7()}`;
    const requestId = `itest-add-${uuidv7()}`;

    await seedOpenBill(dbModule.db, billId);

    const first = await activityModule.addLineItem({
      requestId,
      billId,
      description: "Subscription Fee",
      amount: "12.50",
      currency: "USD"
    });
    const second = await activityModule.addLineItem({
      requestId,
      billId,
      description: "Subscription Fee",
      amount: "12.50",
      currency: "USD"
    });

    expect(second).toEqual(first);

    const lineItemCount = await scalarCount(
      dbModule.db,
      "SELECT COUNT(*) AS count FROM bill_line_items WHERE bill_id = $1",
      billId
    );
    const idemCount = await scalarCount(
      dbModule.db,
      "SELECT COUNT(*) AS count FROM idempotency_records WHERE idem_key = $1",
      requestId
    );

    expect(lineItemCount).toBe(1);
    expect(idemCount).toBe(1);
  });

  test("rejectLineItem replays the stored rejection response for the same request", async () => {
    const billId = `itest-bill-${uuidv7()}`;
    const addRequestId = `itest-add-${uuidv7()}`;
    const rejectRequestId = `itest-reject-${uuidv7()}`;

    await seedOpenBill(dbModule.db, billId);

    const added = await activityModule.addLineItem({
      requestId: addRequestId,
      billId,
      description: "Trading Fee",
      amount: "7.25",
      currency: "USD"
    });

    const first = await activityModule.rejectLineItem({
      requestId: rejectRequestId,
      billId,
      lineItemId: added.lineItemId,
      reason: "duplicate charge"
    });
    const second = await activityModule.rejectLineItem({
      requestId: rejectRequestId,
      billId,
      lineItemId: added.lineItemId,
      reason: "duplicate charge"
    });

    expect(second).toEqual(first);

    const rejected = await dbModule.db.rawQueryRow<{
      status: string;
      rejection_reason: string | null;
      rejected_at: string | Date | null;
    }>(
      `
        SELECT status, rejection_reason, rejected_at
        FROM bill_line_items
        WHERE id = $1
      `,
      added.lineItemId
    );

    expect(rejected).not.toBeNull();
    expect(rejected?.status).toBe("REJECTED");
    expect(rejected?.rejection_reason).toBe("duplicate charge");
    expect(rejected?.rejected_at).not.toBeNull();
  });

  test("closeAndCompleteBill finalizes the bill total using only ADDED items", async () => {
    const billId = `itest-bill-${uuidv7()}`;

    await seedOpenBill(dbModule.db, billId);

    const kept = await activityModule.addLineItem({
      requestId: `itest-add-${uuidv7()}`,
      billId,
      description: "Platform Fee",
      amount: "10.00",
      currency: "USD"
    });
    const rejected = await activityModule.addLineItem({
      requestId: `itest-add-${uuidv7()}`,
      billId,
      description: "Duplicate Platform Fee",
      amount: "3.50",
      currency: "USD"
    });

    await activityModule.rejectLineItem({
      requestId: `itest-reject-${uuidv7()}`,
      billId,
      lineItemId: rejected.lineItemId,
      reason: "duplicate"
    });

    const lifecycle = await activityModule.closeAndCompleteBill(billId);

    expect(lifecycle.close.billId).toBe(billId);
    expect(lifecycle.complete.billId).toBe(billId);
    expect(lifecycle.complete.totalAmount).toBe("10.00");

    const bill = await dbModule.db.rawQueryRow<{
      status: string;
      total_minor: string | number | bigint;
      closed_at: string | Date | null;
      completed_at: string | Date | null;
    }>(
      `
        SELECT status, total_minor, closed_at, completed_at
        FROM bills
        WHERE id = $1
      `,
      billId
    );

    expect(kept.lineItemId).toBeTruthy();
    expect(bill).not.toBeNull();
    expect(bill?.status).toBe("COMPLETED");
    expect(String(bill?.total_minor)).toBe("1000");
    expect(bill?.closed_at).not.toBeNull();
    expect(bill?.completed_at).not.toBeNull();
  });
});

async function seedOpenBill(
  db: typeof import("../db").db,
  billId: string,
  currency: "USD" | "GEL" = "USD"
): Promise<void> {
  await db.rawExec(
    `
      INSERT INTO bills (id, currency, status, workflow_state, period_start, period_end)
      VALUES ($1, $2, 'OPEN', 'STARTED', $3, $4)
    `,
    billId,
    currency,
    "2026-03-01T00:00:00Z",
    "2026-03-31T23:59:59Z"
  );
}

async function scalarCount(
  db: typeof import("../db").db,
  sql: string,
  value: string
): Promise<number> {
  const row = await db.rawQueryRow<{ count: string | number | bigint }>(sql, value);
  return Number(row?.count ?? 0);
}
