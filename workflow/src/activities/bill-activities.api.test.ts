import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fetchMock = vi.fn<typeof fetch>();

vi.mock("encore.dev/config", () => ({
  secret: (name: string) => () => {
    const value = process.env[name]?.trim();
    if (!value) {
      throw new Error(`secret ${name} is not set`);
    }
    return value;
  }
}));

describe("bill activities backend api integration", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.BACKEND_API_BASE_URL = "http://backend.test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BACKEND_API_BASE_URL;
  });

  test("addLineItem posts to the backend workflow endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          lineItemId: "li_001",
          billId: "bill_001",
          description: "Subscription Fee",
          amount: "12.50",
          status: "ADDED",
          createdAt: "2026-03-07T00:00:00.000Z"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    const { addLineItem } = await import("./bill-activities");
    const result = await addLineItem({
      requestId: "req-add-1",
      billId: "bill_001",
      description: "Subscription Fee",
      amount: "12.50",
      currency: "USD"
    });

    expect(result).toEqual({
      lineItemId: "li_001",
      billId: "bill_001",
      description: "Subscription Fee",
      amount: "12.50",
      status: "ADDED",
      createdAt: "2026-03-07T00:00:00.000Z"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/workflow/bills/bill_001/line-items",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "req-add-1",
          billId: "bill_001",
          description: "Subscription Fee",
          amount: "12.50",
          currency: "USD"
        })
      })
    );
  });

  test("closeAndCompleteBill maps backend validation failures to non-retryable activity failures", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: "only OPEN bills can be closed",
          details: { code: "BillNotOpen" }
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" }
        }
      )
    );

    const { closeAndCompleteBill } = await import("./bill-activities");

    await expect(closeAndCompleteBill("bill_002")).rejects.toMatchObject({
      nonRetryable: true,
      message: "only OPEN bills can be closed"
    });
  });

  test("network failures become retryable backend availability failures", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const { rejectLineItem } = await import("./bill-activities");

    await expect(
      rejectLineItem({
        requestId: "req-reject-1",
        billId: "bill_003",
        lineItemId: "li_003",
        reason: "duplicate"
      })
    ).rejects.toMatchObject({
      nonRetryable: false,
      message: expect.stringContaining("connect ECONNREFUSED")
    });
  });
});
