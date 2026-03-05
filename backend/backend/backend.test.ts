import { describe, expect, test } from "vitest";
import {
  addLineItem,
  closeBill,
  completeBill,
  createBill,
  getBill,
  getBillLineItems,
  getInvoice,
  queryBills,
  rejectLineItem
} from "./backend";

describe("billing", () => {
  test("idempotency replay for createBill returns original response", async () => {
    const previousEnv = process.env.TEST_IDEMPOTENCY_KEY;
    process.env.TEST_IDEMPOTENCY_KEY = "idem-create-replay";

    try {
      const req = {
        currency: "USD" as const,
        periodStart: "2026-10-01T00:00:00Z",
        periodEnd: "2026-10-31T23:59:59Z"
      };
      const first = await createBill(req);
      const second = await createBill(req);

      expect(second.billId).toBe(first.billId);
      expect(second.periodStart).toBe(first.periodStart);
      expect(second.periodEnd).toBe(first.periodEnd);
    } finally {
      if (previousEnv === undefined) delete process.env.TEST_IDEMPOTENCY_KEY;
      else process.env.TEST_IDEMPOTENCY_KEY = previousEnv;
    }
  });

  test("idempotency conflict for createBill rejects different payload", async () => {
    const previousEnv = process.env.TEST_IDEMPOTENCY_KEY;
    process.env.TEST_IDEMPOTENCY_KEY = "idem-create-conflict";

    try {
      await createBill({
        currency: "USD",
        periodStart: "2026-11-01T00:00:00Z",
        periodEnd: "2026-11-30T23:59:59Z"
      });

      await expect(
        createBill({
          currency: "USD",
          periodStart: "2026-11-01T00:00:00Z",
          periodEnd: "2026-12-01T23:59:59Z"
        })
      ).rejects.toMatchObject({
        details: { code: "IdempotencyKeyConflict" }
      });
    } finally {
      if (previousEnv === undefined) delete process.env.TEST_IDEMPOTENCY_KEY;
      else process.env.TEST_IDEMPOTENCY_KEY = previousEnv;
    }
  });

  test("idempotency replay for addLineItem does not duplicate rows", async () => {
    const bill = await createBill({
      currency: "USD",
      periodStart: "2026-12-01T00:00:00Z",
      periodEnd: "2026-12-31T23:59:59Z"
    });

    const previousEnv = process.env.TEST_IDEMPOTENCY_KEY;
    process.env.TEST_IDEMPOTENCY_KEY = "idem-add-replay";
    try {
      const req = {
        billId: bill.billId,
        description: "Replay Fee",
        amount: "4.20",
        currency: "USD" as const
      };
      const first = await addLineItem(req);
      const second = await addLineItem(req);
      expect(second.lineItemId).toBe(first.lineItemId);

      const items = await getBillLineItems({ billId: bill.billId });
      const replayItems = items.items.filter((i) => i.description === "Replay Fee");
      expect(replayItems).toHaveLength(1);
    } finally {
      if (previousEnv === undefined) delete process.env.TEST_IDEMPOTENCY_KEY;
      else process.env.TEST_IDEMPOTENCY_KEY = previousEnv;
    }
  });

  test("idempotency conflict for addLineItem rejects different payload", async () => {
    const bill = await createBill({
      currency: "USD",
      periodStart: "2027-01-01T00:00:00Z",
      periodEnd: "2027-01-31T23:59:59Z"
    });

    const previousEnv = process.env.TEST_IDEMPOTENCY_KEY;
    process.env.TEST_IDEMPOTENCY_KEY = "idem-add-conflict";
    try {
      await addLineItem({
        billId: bill.billId,
        description: "Conflict Fee",
        amount: "1.00",
        currency: "USD"
      });

      await expect(
        addLineItem({
          billId: bill.billId,
          description: "Conflict Fee",
          amount: "2.00",
          currency: "USD"
        })
      ).rejects.toMatchObject({
        details: { code: "IdempotencyKeyConflict" }
      });
    } finally {
      if (previousEnv === undefined) delete process.env.TEST_IDEMPOTENCY_KEY;
      else process.env.TEST_IDEMPOTENCY_KEY = previousEnv;
    }
  });

  test("idempotency replay for rejectLineItem returns original response", async () => {
    const bill = await createBill({
      currency: "USD",
      periodStart: "2027-02-01T00:00:00Z",
      periodEnd: "2027-02-28T23:59:59Z"
    });
    const added = await addLineItem({
      billId: bill.billId,
      description: "Reject Replay Fee",
      amount: "3.33",
      currency: "USD"
    });

    const previousEnv = process.env.TEST_IDEMPOTENCY_KEY;
    process.env.TEST_IDEMPOTENCY_KEY = "idem-reject-replay";
    try {
      const req = {
        billId: bill.billId,
        lineItemId: added.lineItemId,
        reason: "Duplicate charge"
      };
      const first = await rejectLineItem(req);
      const second = await rejectLineItem(req);

      expect(second.lineItemId).toBe(first.lineItemId);
      expect(second.status).toBe("REJECTED");

      const items = await getBillLineItems({ billId: bill.billId });
      const rejected = items.items.find((i) => i.id === added.lineItemId);
      expect(rejected?.status).toBe("REJECTED");
    } finally {
      if (previousEnv === undefined) delete process.env.TEST_IDEMPOTENCY_KEY;
      else process.env.TEST_IDEMPOTENCY_KEY = previousEnv;
    }
  });

  test("idempotency conflict for rejectLineItem rejects different payload", async () => {
    const bill = await createBill({
      currency: "USD",
      periodStart: "2027-03-01T00:00:00Z",
      periodEnd: "2027-03-31T23:59:59Z"
    });
    const added = await addLineItem({
      billId: bill.billId,
      description: "Reject Conflict Fee",
      amount: "6.66",
      currency: "USD"
    });

    const previousEnv = process.env.TEST_IDEMPOTENCY_KEY;
    process.env.TEST_IDEMPOTENCY_KEY = "idem-reject-conflict";
    try {
      await rejectLineItem({
        billId: bill.billId,
        lineItemId: added.lineItemId,
        reason: "Duplicate charge"
      });

      await expect(
        rejectLineItem({
          billId: bill.billId,
          lineItemId: added.lineItemId,
          reason: "Wrong bill"
        })
      ).rejects.toMatchObject({
        details: { code: "IdempotencyKeyConflict" }
      });
    } finally {
      if (previousEnv === undefined) delete process.env.TEST_IDEMPOTENCY_KEY;
      else process.env.TEST_IDEMPOTENCY_KEY = previousEnv;
    }
  });

  test("idempotency replay for closeBill returns original response", async () => {
    const bill = await createBill({
      currency: "USD",
      periodStart: "2027-04-01T00:00:00Z",
      periodEnd: "2027-04-30T23:59:59Z"
    });

    const previousEnv = process.env.TEST_IDEMPOTENCY_KEY;
    process.env.TEST_IDEMPOTENCY_KEY = "idem-close-replay";
    try {
      const req = { billId: bill.billId };
      const first = await closeBill(req);
      const second = await closeBill(req);

      expect(second.billId).toBe(first.billId);
      expect(second.status).toBe("CLOSED");
      expect(second.closedAt).toBe(first.closedAt);
    } finally {
      if (previousEnv === undefined) delete process.env.TEST_IDEMPOTENCY_KEY;
      else process.env.TEST_IDEMPOTENCY_KEY = previousEnv;
    }
  });

  test("idempotency replay for completeBill returns original response", async () => {
    const bill = await createBill({
      currency: "USD",
      periodStart: "2027-05-01T00:00:00Z",
      periodEnd: "2027-05-31T23:59:59Z"
    });
    await addLineItem({
      billId: bill.billId,
      description: "Complete Replay Fee",
      amount: "10.00",
      currency: "USD"
    });
    await closeBill({ billId: bill.billId });

    const previousEnv = process.env.TEST_IDEMPOTENCY_KEY;
    process.env.TEST_IDEMPOTENCY_KEY = "idem-complete-replay";
    try {
      const req = { billId: bill.billId };
      const first = await completeBill(req);
      const second = await completeBill(req);

      expect(second.billId).toBe(first.billId);
      expect(second.status).toBe("COMPLETED");
      expect(second.totalAmount).toBe(first.totalAmount);
      expect(second.completedAt).toBe(first.completedAt);
    } finally {
      if (previousEnv === undefined) delete process.env.TEST_IDEMPOTENCY_KEY;
      else process.env.TEST_IDEMPOTENCY_KEY = previousEnv;
    }
  });

  test("requires idempotency key outside api-call context when NODE_ENV is not test", async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      await expect(
        createBill({
          currency: "USD",
          periodStart: "2026-03-01T00:00:00Z",
          periodEnd: "2026-03-31T23:59:59Z"
        })
      ).rejects.toMatchObject({
        details: { code: "MissingIdempotencyKey" }
      });
    } finally {
      if (previousEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousEnv;
      }
    }
  });

  test("requires idempotency key outside api-call context when NODE_ENV is unset", async () => {
    const previousEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;

    try {
      await expect(
        createBill({
          currency: "USD",
          periodStart: "2026-03-01T00:00:00Z",
          periodEnd: "2026-03-31T23:59:59Z"
        })
      ).rejects.toMatchObject({
        details: { code: "MissingIdempotencyKey" }
      });
    } finally {
      if (previousEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousEnv;
      }
    }
  });

  test("adds line item, rejects one item, completes bill, and computes total at complete", async () => {
    const created = await createBill({
      currency: "USD",
      periodStart: "2026-03-01T00:00:00Z",
      periodEnd: "2026-03-31T23:59:59Z"
    });

    const lineItem1 = await addLineItem({
      billId: created.billId,
      description: "Trading Fee",
      amount: "25.50",
      currency: "USD"
    });

    const lineItem2 = await addLineItem({
      billId: created.billId,
      description: "Custody Fee",
      amount: "5.00",
      currency: "USD"
    });

    expect(lineItem1.status).toBe("ADDED");
    expect(lineItem2.status).toBe("ADDED");

    const rejected = await rejectLineItem({
      billId: created.billId,
      lineItemId: lineItem1.lineItemId,
      reason: "Duplicate charge"
    });
    expect(rejected.status).toBe("REJECTED");

    const billBeforeClose = await getBill({ billId: created.billId });
    expect(billBeforeClose.totalAmount).toBe("0.00");

    const closed = await closeBill({ billId: created.billId });
    expect(closed.status).toBe("CLOSED");

    const completed = await completeBill({ billId: created.billId });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.totalAmount).toBe("5.00");

    const invoice = await getInvoice({ billId: created.billId });
    expect(invoice.totalAmount).toBe("5.00");
    expect(invoice.lineItems).toHaveLength(1);
  });

  test("rejects mismatched line-item currency", async () => {
    const created = await createBill({
      currency: "USD",
      periodStart: "2026-03-01T00:00:00Z",
      periodEnd: "2026-03-31T23:59:59Z"
    });

    await expect(
      addLineItem({
        billId: created.billId,
        description: "GEL Fee",
        amount: "10.00",
        currency: "GEL"
      })
    ).rejects.toMatchObject({
      details: { code: "CurrencyMismatch" }
    });
  });

  test("line-item rejection is allowed only for OPEN bills", async () => {
    const created = await createBill({
      currency: "USD",
      periodStart: "2026-03-01T00:00:00Z",
      periodEnd: "2026-03-31T23:59:59Z"
    });

    const added = await addLineItem({
      billId: created.billId,
      description: "Late Fee",
      amount: "10.00",
      currency: "USD"
    });

    await closeBill({ billId: created.billId });

    await expect(
      rejectLineItem({
        billId: created.billId,
        lineItemId: added.lineItemId,
        reason: "Duplicate"
      })
    ).rejects.toMatchObject({
      details: { code: "BillNotOpen" }
    });
  });

  test("rejected item cannot change status again", async () => {
    const created = await createBill({
      currency: "USD",
      periodStart: "2026-04-01T00:00:00Z",
      periodEnd: "2026-04-30T23:59:59Z"
    });

    const added = await addLineItem({
      billId: created.billId,
      description: "Fee",
      amount: "9.00",
      currency: "USD"
    });

    await rejectLineItem({
      billId: created.billId,
      lineItemId: added.lineItemId,
      reason: "Duplicate"
    });

    await expect(
      rejectLineItem({
        billId: created.billId,
        lineItemId: added.lineItemId,
        reason: "Duplicate again"
      })
    ).rejects.toMatchObject({
      details: { code: "LineItemAlreadyRejected" }
    });
  });

  test("queries bills by OPEN/CLOSED/COMPLETED status", async () => {
    const openBill = await createBill({
      currency: "USD",
      periodStart: "2026-05-01T00:00:00Z",
      periodEnd: "2026-05-31T23:59:59Z"
    });

    const closedBill = await createBill({
      currency: "GEL",
      periodStart: "2026-06-01T00:00:00Z",
      periodEnd: "2026-06-30T23:59:59Z"
    });
    await closeBill({ billId: closedBill.billId });

    const completedBill = await createBill({
      currency: "USD",
      periodStart: "2026-07-01T00:00:00Z",
      periodEnd: "2026-07-31T23:59:59Z"
    });
    await closeBill({ billId: completedBill.billId });
    await completeBill({ billId: completedBill.billId });

    const openOnly = await queryBills({ status: "OPEN" });
    const closedOnly = await queryBills({ status: "CLOSED" });
    const completedOnly = await queryBills({ status: "COMPLETED" });

    expect(openOnly.bills.some((b) => b.billId === openBill.billId)).toBe(true);
    expect(closedOnly.bills.some((b) => b.billId === closedBill.billId)).toBe(true);
    expect(completedOnly.bills.some((b) => b.billId === completedBill.billId)).toBe(true);
  });

  test("rejects missing bill status query", async () => {
    await expect(queryBills({} as any)).rejects.toMatchObject({
      details: { code: "InvalidStatus" }
    });
  });

  test("rejects invoice retrieval before completion", async () => {
    const created = await createBill({
      currency: "USD",
      periodStart: "2026-08-01T00:00:00Z",
      periodEnd: "2026-08-31T23:59:59Z"
    });

    await closeBill({ billId: created.billId });

    await expect(getInvoice({ billId: created.billId })).rejects.toMatchObject({
      details: { code: "BillNotCompleted" }
    });
  });

  test("returns bill and line item status fields", async () => {
    const created = await createBill({
      currency: "USD",
      periodStart: "2026-09-01T00:00:00Z",
      periodEnd: "2026-09-30T23:59:59Z"
    });

    const added = await addLineItem({
      billId: created.billId,
      description: "Ops",
      amount: "7.25",
      currency: "USD"
    });

    const bill = await getBill({ billId: created.billId });
    const lineItems = await getBillLineItems({ billId: created.billId });

    expect(bill.status).toBe("OPEN");
    expect(bill.totalAmount).toBe("0.00");
    expect(lineItems.items).toHaveLength(1);
    expect(lineItems.items[0].id).toBe(added.lineItemId);
    expect(lineItems.items[0].status).toBe("ADDED");
    expect(lineItems.items[0].amount).toBe("7.25");
  });
});
