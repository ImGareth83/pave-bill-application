import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockState = vi.hoisted(() => {
  class MockAPIError extends Error {
    details?: Record<string, unknown>;

    withDetails(details: Record<string, unknown>) {
      this.details = details;
      return this;
    }

    static invalidArgument(message: string) {
      return new MockAPIError(message);
    }

    static aborted(message: string) {
      return new MockAPIError(message);
    }

    static internal(message: string) {
      return new MockAPIError(message);
    }

    static notFound(message: string) {
      return new MockAPIError(message);
    }

    static unavailable(message: string) {
      return new MockAPIError(message);
    }

    static unauthenticated(message: string) {
      return new MockAPIError(message);
    }
  }

  type BillRecord = {
    id: string;
    currency: "USD" | "GEL";
    status: "OPEN" | "CLOSED" | "COMPLETED";
    workflow_state: "NOT_STARTED" | "STARTED";
    period_start: string;
    period_end: string;
    created_at: string;
    closed_at: string | null;
    completed_at: string | null;
    total_minor: string;
  };

  const now = "2026-03-07T00:00:00.000Z";
  const bills = new Map<string, BillRecord>();
  const idempotency = new Map<
    string,
    {
      request_hash: string;
      response_json: unknown | null;
      state: "PENDING" | "COMPLETED";
      http_code: number | null;
    }
  >();

  type TemporalMocks = {
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    executeUpdate: ReturnType<typeof vi.fn>;
    getHandle: ReturnType<typeof vi.fn>;
  };

  const temporal: TemporalMocks = {
    connect: vi.fn<() => Promise<{ kind: string }>>(async () => ({ kind: "connection" })),
    start: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ workflowId: "unused" })),
    executeUpdate: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {
      throw new Error("executeUpdate mock not configured");
    }),
    getHandle: vi.fn((workflowId: string) => ({
      workflowId,
      executeUpdate: temporal.executeUpdate
    }))
  };

  const currentRequest = vi.fn<() => unknown>(() => undefined);

  function reset() {
    bills.clear();
    idempotency.clear();
    temporal.connect.mockClear();
    temporal.start.mockReset();
    temporal.start.mockResolvedValue({ workflowId: "unused" });
    temporal.executeUpdate.mockReset();
    temporal.executeUpdate.mockRejectedValue(new Error("executeUpdate mock not configured"));
    temporal.getHandle.mockClear();
    currentRequest.mockReset();
    currentRequest.mockReturnValue(undefined);
  }

  function queryIdempotency(scope: string, idemKey: string) {
    return idempotency.get(`${scope}:${idemKey}`) ?? null;
  }

  function storeIdempotency(
    scope: string,
    idemKey: string,
    requestHash: string,
    responseJson: unknown,
    state: "PENDING" | "COMPLETED" = "COMPLETED"
  ) {
    const key = `${scope}:${idemKey}`;
    if (idempotency.has(key)) {
      const err = new Error("duplicate");
      (err as Error & { code: string }).code = "23505";
      throw err;
    }
    idempotency.set(key, {
      request_hash: requestHash,
      response_json: responseJson,
      state,
      http_code: state === "COMPLETED" ? 200 : null
    });
  }

  function updateIdempotency(
    scope: string,
    idemKey: string,
    requestHash: string,
    responseJson: unknown
  ) {
    const key = `${scope}:${idemKey}`;
    const existing = idempotency.get(key);
    if (!existing || existing.request_hash !== requestHash) {
      throw new Error(`missing idempotency row for ${key}`);
    }
    idempotency.set(key, {
      request_hash: requestHash,
      response_json: responseJson,
      state: "COMPLETED",
      http_code: 200
    });
  }

  function insertBill(
    id: string,
    currency: "USD" | "GEL",
    periodStart: Date | string,
    periodEnd: Date | string,
    workflowState: "NOT_STARTED" | "STARTED" = "NOT_STARTED"
  ) {
    bills.set(id, {
      id,
      currency,
      status: "OPEN",
      workflow_state: workflowState,
      period_start: new Date(periodStart).toISOString(),
      period_end: new Date(periodEnd).toISOString(),
      created_at: now,
      closed_at: null,
      completed_at: null,
      total_minor: "0"
    });
  }

  function queryBill(billId: string) {
    return bills.get(billId) ?? null;
  }

  function markBillWorkflowStarted(billId: string) {
    const bill = bills.get(billId);
    if (!bill) {
      throw new Error(`missing bill ${billId}`);
    }
    bill.workflow_state = "STARTED";
  }

  class MockSQLDatabase {
    constructor(_name: string, _cfg: unknown) {}

    async begin() {
      return {
        queryRow: createTaggedQueryRow(),
        query: createTaggedQuery(),
        exec: createTaggedExec(),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined)
      };
    }

    exec = createTaggedExec();
    queryRow = createTaggedQueryRow();

    query = createTaggedQuery();
  }

  function createTaggedExec() {
    return async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(" ");
      if (sql.includes("INSERT INTO bills")) {
        insertBill(
          values[0] as string,
          values[1] as "USD" | "GEL",
          values[2] as Date | string,
          values[3] as Date | string
        );
        return;
      }

      if (sql.includes("UPDATE bills") && sql.includes("workflow_state = 'STARTED'")) {
        markBillWorkflowStarted(values[0] as string);
        return;
      }

      if (sql.includes("INSERT INTO idempotency_records")) {
        if (sql.includes("VALUES (") && values.length === 3) {
          storeIdempotency(
            values[0] as string,
            values[1] as string,
            values[2] as string,
            null,
            "PENDING"
          );
          return;
        }

        storeIdempotency(
          values[0] as string,
          values[1] as string,
          values[2] as string,
          values[3]
        );
        return;
      }

      if (sql.includes("UPDATE idempotency_records")) {
        updateIdempotency(
          values[1] as string,
          values[2] as string,
          values[3] as string,
          values[0]
        );
        return;
      }

      throw new Error(`Unhandled exec SQL: ${sql}`);
    };
  }

  function createTaggedQueryRow() {
    return async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(" ");
      if (sql.includes("FROM idempotency_records")) {
        return queryIdempotency(values[0] as string, values[1] as string);
      }

      if (sql.includes("SELECT 1 AS ok")) {
        return { ok: 1 };
      }

      if (sql.includes("FROM bills") && sql.includes("WHERE id =")) {
        return queryBill(values[0] as string);
      }

      return null;
    };
  }

  function createTaggedQuery() {
    return async function* () {
      return;
    };
  }

  return {
    MockAPIError,
    MockSQLDatabase,
    bills,
    idempotency,
    temporal,
    currentRequest,
    storeIdempotency,
    reset,
    now
  };
});

vi.mock("encore.dev/api", () => ({
  api: (_config: unknown, fn: unknown) => fn,
  APIError: mockState.MockAPIError
}));

vi.mock("encore.dev", () => ({
  currentRequest: mockState.currentRequest
}));

vi.mock("encore.dev/config", () => ({
  secret: (name: string) => {
    return () => {
      const value = process.env[name]?.trim();
      if (!value) {
        throw new Error(`secret ${name} is not set`);
      }
      return value;
    };
  }
}));

vi.mock("encore.dev/storage/sqldb", () => ({
  SQLDatabase: mockState.MockSQLDatabase
}));

vi.mock("./db", () => ({
  db: new mockState.MockSQLDatabase("backend", { migrations: "./backend/migrations" })
}));

vi.mock("@temporalio/client", async () => {
  const actual = await vi.importActual<typeof import("@temporalio/client")>("@temporalio/client");

  class MockConnection {
    static connect = mockState.temporal.connect;
  }

  class MockClient {
    workflow = {
      start: mockState.temporal.start,
      getHandle: mockState.temporal.getHandle
    };

    constructor(_options: unknown) {}
  }

  return {
    ...actual,
    Connection: MockConnection,
    Client: MockClient
  };
});

beforeEach(() => {
  vi.resetModules();
  mockState.reset();
  process.env.NODE_ENV = "test";
  delete process.env.TEST_IDEMPOTENCY_KEY;
  process.env.TEMPORAL_ADDRESS = "temporal.test:7233";
  process.env.TEMPORAL_NAMESPACE = "test-namespace";
  process.env.TEMPORAL_TASK_QUEUE = "billing-periods";
  process.env.TEMPORAL_API_KEY = "test-api-key";
});

afterEach(() => {
  delete process.env.TEST_IDEMPOTENCY_KEY;
  delete process.env.TEMPORAL_ADDRESS;
  delete process.env.TEMPORAL_NAMESPACE;
  delete process.env.TEMPORAL_TASK_QUEUE;
  delete process.env.TEMPORAL_API_KEY;
});

async function loadBackend() {
  return import("./backend");
}

function buildCloseResponse(closedAt: string) {
  return {
    billId: "bill_001",
    status: "CLOSED" as const,
    closedAt,
    totalAmount: "12.50",
    lineItems: [
      {
        id: "li_001",
        description: "Trading Fee",
        amount: "12.50",
        currency: "USD" as const,
        createdAt: mockState.now
      }
    ]
  };
}

describe("backend temporal integration", () => {
  test("createBill starts one workflow and replays idempotently", async () => {
    process.env.TEST_IDEMPOTENCY_KEY = "idem-create";
    const { createBill } = await loadBackend();

    mockState.temporal.start.mockResolvedValue({ workflowId: "bill/generated" });

    const req = {
      currency: "USD" as const,
      periodStart: "2026-10-01T00:00:00Z",
      periodEnd: "2026-10-31T23:59:59Z"
    };

    const first = await createBill(req);
    const second = await createBill(req);

    expect(second).toEqual(first);
    expect(mockState.temporal.start).toHaveBeenCalledTimes(1);
    expect(mockState.temporal.start).toHaveBeenNthCalledWith(
      1,
      "billPeriodWorkflow",
      expect.objectContaining({
        taskQueue: "billing-periods",
        workflowId: `bill/${first.billId}`,
        args: [
          expect.objectContaining({
            billId: first.billId,
            currency: "USD",
            periodStart: "2026-10-01T00:00:00.000Z",
            periodEnd: "2026-10-31T23:59:59.000Z"
          })
        ]
      })
    );
    expect(mockState.bills.get(first.billId)).toMatchObject({ workflow_state: "STARTED" });
  });

  test("createBill retries can recover when workflow start fails after the bill commit", async () => {
    process.env.TEST_IDEMPOTENCY_KEY = "idem-create-retry";
    const { createBill } = await loadBackend();

    mockState.temporal.start
      .mockRejectedValueOnce(new Error("temporal unavailable"))
      .mockResolvedValueOnce({ workflowId: "bill/generated" });

    const req = {
      currency: "USD" as const,
      periodStart: "2026-11-01T00:00:00Z",
      periodEnd: "2026-11-30T23:59:59Z"
    };

    await expect(createBill(req)).rejects.toThrow("workflow service unavailable");

    const recovered = await createBill(req);

    expect(recovered.status).toBe("OPEN");
    expect(mockState.temporal.start).toHaveBeenCalledTimes(2);
    expect(mockState.bills.get(recovered.billId)).toMatchObject({
      id: recovered.billId,
      currency: "USD",
      status: "OPEN",
      workflow_state: "STARTED"
    });
  });

  test("addLineItem delegates to workflow update and reuses the same response on replay", async () => {
    process.env.TEST_IDEMPOTENCY_KEY = "idem-add";
    const { addLineItem } = await loadBackend();

    mockState.temporal.executeUpdate.mockResolvedValueOnce({
      lineItemId: "li_001",
      billId: "bill_001",
      description: "Trading Fee",
      amount: "12.50",
      status: "ADDED",
      createdAt: mockState.now
    });

    const req = {
      billId: "bill_001",
      description: "Trading Fee",
      amount: "12.50",
      currency: "USD" as const
    };

    const first = await addLineItem(req);
    const second = await addLineItem(req);

    expect(second).toEqual(first);
    expect(mockState.temporal.getHandle).toHaveBeenCalledWith("bill/bill_001");
    expect(mockState.temporal.executeUpdate).toHaveBeenCalledTimes(1);
    expect(mockState.temporal.executeUpdate).toHaveBeenCalledWith("addLineItem", {
      args: [
        {
          requestId: "idem-add",
          billId: "bill_001",
          description: "Trading Fee",
          amount: "12.50",
          currency: "USD"
        }
      ]
    });
  });

  test("addLineItem completes a pending backend idempotency record from workflow replay", async () => {
    process.env.TEST_IDEMPOTENCY_KEY = "idem-add-pending";
    const { addLineItem } = await loadBackend();

    const workflowResponse = {
      lineItemId: "li_002",
      billId: "bill_002",
      description: "Custody Fee",
      amount: "9.00",
      status: "ADDED" as const,
      createdAt: mockState.now
    };

    mockState.temporal.executeUpdate.mockRejectedValueOnce(new Error("socket dropped"));

    await expect(
      addLineItem({
        billId: "bill_002",
        description: "Custody Fee",
        amount: "9.00",
        currency: "USD"
      })
    ).rejects.toThrow("workflow service unavailable");

    const pending = mockState.idempotency.get("add_line_item:bill_002:idem-add-pending");
    expect(pending).toMatchObject({
      state: "PENDING",
      response_json: null
    });

    mockState.temporal.executeUpdate.mockReset();
    mockState.temporal.executeUpdate.mockRejectedValue(new Error("executeUpdate mock not configured"));
    mockState.storeIdempotency(
      "workflow_add_line_item:bill_002",
      "idem-add-pending",
      pending?.request_hash as string,
      workflowResponse
    );

    const replayed = await addLineItem({
      billId: "bill_002",
      description: "Custody Fee",
      amount: "9.00",
      currency: "USD"
    });

    expect(replayed).toEqual(workflowResponse);
    expect(mockState.temporal.executeUpdate).not.toHaveBeenCalled();
  });

  test("closeBill delegates to workflow close update using the idempotency key as requestId", async () => {
    process.env.TEST_IDEMPOTENCY_KEY = "idem-close";
    const { closeBill } = await loadBackend();

    mockState.temporal.executeUpdate.mockResolvedValueOnce(buildCloseResponse(mockState.now));

    const result = await closeBill({ billId: "bill_001" });

    expect(result).toEqual(buildCloseResponse(mockState.now));
    expect(mockState.temporal.executeUpdate).toHaveBeenCalledWith("closeBill", {
      args: [{ requestId: "idem-close", billId: "bill_001" }]
    });
  });

  test("workflow application failures are mapped back to API errors", async () => {
    process.env.TEST_IDEMPOTENCY_KEY = "idem-error";
    const { addLineItem } = await loadBackend();
    const { WorkflowUpdateFailedError, ApplicationFailure } = await import("@temporalio/client");

    mockState.temporal.executeUpdate.mockRejectedValueOnce(
      new WorkflowUpdateFailedError(
        "workflow update failed",
        ApplicationFailure.nonRetryable(
          "line item additions are allowed only for OPEN bills",
          "InvalidArgument",
          { code: "BillNotOpen" }
        )
      )
    );

    await expect(
      addLineItem({
        billId: "bill_001",
        description: "Late Fee",
        amount: "1.00",
        currency: "USD"
      })
    ).rejects.toMatchObject({
      details: { code: "BillNotOpen" },
      message: "line item additions are allowed only for OPEN bills"
    });
  });

  test("serialized workflow application failures are mapped back to API errors", async () => {
    process.env.TEST_IDEMPOTENCY_KEY = "idem-error-serialized";
    const { addLineItem } = await loadBackend();
    const { WorkflowUpdateFailedError } = await import("@temporalio/client");

    mockState.temporal.executeUpdate.mockRejectedValueOnce(
      new WorkflowUpdateFailedError("workflow update failed", {
        message: "bill is no longer open for mutations",
        type: "InvalidArgument",
        details: [{ code: "BillNotOpen" }]
      } as unknown as Error)
    );

    await expect(
      addLineItem({
        billId: "bill_001",
        description: "Late Fee",
        amount: "1.00",
        currency: "USD"
      })
    ).rejects.toMatchObject({
      details: { code: "BillNotOpen" },
      message: "bill is no longer open for mutations"
    });
  });

  test("completed workflow update failures are mapped back to API errors", async () => {
    process.env.TEST_IDEMPOTENCY_KEY = "idem-error-completed";
    const { addLineItem } = await loadBackend();
    const { WorkflowNotFoundError } = await import("@temporalio/client");

    mockState.temporal.executeUpdate.mockRejectedValueOnce(
      new WorkflowNotFoundError(
        "workflow execution already completed",
        "bill/bill_001",
        undefined
      )
    );

    await expect(
      addLineItem({
        billId: "bill_001",
        description: "Late Fee",
        amount: "1.00",
        currency: "USD"
      })
    ).rejects.toMatchObject({
      details: { code: "BillNotOpen" },
      message: "bill is no longer open for mutations"
    });
  });

  test("completeBill now rejects until the workflow has completed the bill", async () => {
    const { completeBill } = await loadBackend();

    mockState.bills.set("bill_001", {
      id: "bill_001",
      currency: "USD",
      status: "OPEN",
      workflow_state: "STARTED",
      period_start: "2026-03-01T00:00:00.000Z",
      period_end: "2026-03-31T23:59:59.000Z",
      created_at: mockState.now,
      closed_at: null,
      completed_at: null,
      total_minor: "0"
    });

    await expect(completeBill({ billId: "bill_001" })).rejects.toMatchObject({
      details: { code: "BillCompletionManagedByWorkflow" }
    });
  });
});
