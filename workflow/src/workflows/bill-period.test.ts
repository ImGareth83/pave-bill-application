import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function buildCloseResponse() {
  return {
    billId: "bill_001",
    status: "CLOSED" as const,
    closedAt: "2026-03-07T00:00:00.000Z",
    totalAmount: "12.50",
    lineItems: [
      {
        id: "li_001",
        description: "Trading Fee",
        amount: "12.50",
        currency: "USD" as const,
        createdAt: "2026-03-07T00:00:00.000Z"
      }
    ]
  };
}

const workflowMockState = vi.hoisted(() => {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();

  let sleepImpl: (ms: number) => Promise<void> = async () => undefined;
  let activities = {
    addLineItem: vi.fn(async (input: unknown) => input),
    rejectLineItem: vi.fn(async (input: unknown) => input),
    closeAndCompleteBill: vi.fn(async (_billId: string) => ({
      close: buildCloseResponse(),
      complete: {
        billId: "bill_001",
        status: "COMPLETED" as const,
        totalAmount: "12.50",
        completedAt: "2026-03-07T00:00:00.000Z"
      }
    }))
  };

  function reset() {
    handlers.clear();
    sleepImpl = async () => undefined;
    activities = {
      addLineItem: vi.fn(async (input: unknown) => input),
      rejectLineItem: vi.fn(async (input: unknown) => input),
      closeAndCompleteBill: vi.fn(async (_billId: string) => ({
        close: buildCloseResponse(),
        complete: {
          billId: "bill_001",
          status: "COMPLETED" as const,
          totalAmount: "12.50",
          completedAt: "2026-03-07T00:00:00.000Z"
        }
      }))
    };
  }

  return {
    handlers,
    get activities() {
      return activities;
    },
    setActivities(next: typeof activities) {
      activities = next;
    },
    setSleep(fn: typeof sleepImpl) {
      sleepImpl = fn;
    },
    sleep(ms: number) {
      return sleepImpl(ms);
    },
    reset
  };
});

vi.mock("@temporalio/workflow", () => ({
  defineUpdate: <Ret, Args extends unknown[]>(name: string) => name as unknown as {
    __ret?: Ret;
    __args?: Args;
  },
  proxyActivities: () => workflowMockState.activities,
  setHandler: (name: string, handler: (input: unknown) => Promise<unknown>) => {
    workflowMockState.handlers.set(name, handler);
  },
  sleep: (ms: number) => workflowMockState.sleep(ms),
  condition: (predicate: () => boolean) =>
    new Promise<void>((resolve) => {
      const tick = () => {
        if (predicate()) {
          resolve();
          return;
        }
        setTimeout(tick, 0);
      };
      tick();
    })
}));

beforeEach(() => {
  vi.resetModules();
  workflowMockState.reset();
});

afterEach(() => {
  workflowMockState.reset();
});

async function loadWorkflowModule() {
  return import("./bill-period");
}

function getHandler<T>(name: string): (input: T) => Promise<unknown> {
  const handler = workflowMockState.handlers.get(name);
  if (!handler) {
    throw new Error(`missing handler for ${name}`);
  }
  return handler as (input: T) => Promise<unknown>;
}

describe("billPeriodWorkflow", () => {
  test("dedupes concurrent addLineItem updates with the same requestId", async () => {
    let releaseActivity!: () => void;
    const activityStarted = new Promise<void>((resolve) => {
      workflowMockState.setActivities({
        ...workflowMockState.activities,
        addLineItem: vi.fn(
          () =>
            new Promise((resolveResult) => {
              resolve();
              releaseActivity = () =>
                resolveResult({
                  lineItemId: "li_001",
                  billId: "bill_001",
                  description: "Trading Fee",
                  amount: "12.50",
                  status: "ADDED",
                  createdAt: "2026-03-07T00:00:00.000Z"
                });
            })
        )
      });
    });

    workflowMockState.setSleep(
      () =>
        new Promise<void>(() => {
          return;
        })
    );

    const { billPeriodWorkflow } = await loadWorkflowModule();
    void billPeriodWorkflow({
      billId: "bill_001",
      currency: "USD",
      periodStart: "2026-03-01T00:00:00Z",
      periodEnd: "2026-03-31T23:59:59Z"
    });

    const addHandler = getHandler<{
      requestId: string;
      billId: string;
      description: string;
      amount: string;
      currency: "USD";
    }>("addLineItem");

    const first = addHandler({
      requestId: "req-1",
      billId: "bill_001",
      description: "Trading Fee",
      amount: "12.50",
      currency: "USD"
    });
    const second = addHandler({
      requestId: "req-1",
      billId: "bill_001",
      description: "Trading Fee",
      amount: "12.50",
      currency: "USD"
    });

    await activityStarted;
    expect(workflowMockState.activities.addLineItem).toHaveBeenCalledTimes(1);

    releaseActivity();

    await expect(first).resolves.toEqual(await second);
    expect(workflowMockState.activities.addLineItem).toHaveBeenCalledTimes(1);
  });

  test("manual close wakes the workflow early and runs lifecycle once", async () => {
    let sleepResolved = false;
    workflowMockState.setSleep(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            sleepResolved = true;
            resolve();
          }, 50);
        })
    );

    const closeAndCompleteBill = vi.fn(async () => ({
      close: buildCloseResponse(),
      complete: {
        billId: "bill_001",
        status: "COMPLETED" as const,
        totalAmount: "12.50",
        completedAt: "2026-03-07T00:00:00.000Z"
      }
    }));

    workflowMockState.setActivities({
      ...workflowMockState.activities,
      closeAndCompleteBill
    });

    const { billPeriodWorkflow } = await loadWorkflowModule();
    const workflowPromise = billPeriodWorkflow({
      billId: "bill_001",
      currency: "USD",
      periodStart: "2026-03-01T00:00:00Z",
      periodEnd: "2026-03-31T23:59:59Z"
    });

    const closeHandler = getHandler<{ requestId: string; billId: string }>("closeBill");
    const closeResult = await closeHandler({ requestId: "close-1", billId: "bill_001" });
    const finalResult = await workflowPromise;

    expect(closeResult).toEqual(buildCloseResponse());
    expect(finalResult).toEqual({
      billId: "bill_001",
      status: "COMPLETED",
      totalAmount: "12.50",
      completedAt: "2026-03-07T00:00:00.000Z"
    });
    expect(closeAndCompleteBill).toHaveBeenCalledTimes(1);
    expect(sleepResolved).toBe(false);
  });

  test("retries the same close request while closing by joining the in-flight result", async () => {
    let releaseLifecycle!: () => void;
    workflowMockState.setSleep(
      () =>
        new Promise<void>(() => {
          return;
        })
    );

    const closeAndCompleteBill = vi.fn(
      (_billId: string) =>
        new Promise((resolve) => {
          releaseLifecycle = () =>
            resolve({
              close: buildCloseResponse(),
              complete: {
                billId: "bill_001",
                status: "COMPLETED" as const,
                totalAmount: "12.50",
                completedAt: "2026-03-07T00:00:00.000Z"
              }
            });
        })
    );

    workflowMockState.setActivities({
      ...workflowMockState.activities,
      closeAndCompleteBill
    });

    const { billPeriodWorkflow } = await loadWorkflowModule();
    void billPeriodWorkflow({
      billId: "bill_001",
      currency: "USD",
      periodStart: "2026-03-01T00:00:00Z",
      periodEnd: "2026-03-31T23:59:59Z"
    });

    const closeHandler = getHandler<{ requestId: string; billId: string }>("closeBill");
    const first = closeHandler({ requestId: "close-1", billId: "bill_001" });
    const second = closeHandler({ requestId: "close-1", billId: "bill_001" });

    expect(closeAndCompleteBill).toHaveBeenCalledTimes(1);

    releaseLifecycle();

    await expect(first).resolves.toEqual(buildCloseResponse());
    await expect(second).resolves.toEqual(buildCloseResponse());
    expect(closeAndCompleteBill).toHaveBeenCalledTimes(1);
  });

  test("rejects addLineItem once close has started", async () => {
    let releaseLifecycle!: () => void;
    workflowMockState.setSleep(
      () =>
        new Promise<void>(() => {
          return;
        })
    );
    workflowMockState.setActivities({
      ...workflowMockState.activities,
      closeAndCompleteBill: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseLifecycle = () =>
              resolve({
                close: buildCloseResponse(),
                complete: {
                  billId: "bill_001",
                  status: "COMPLETED" as const,
                  totalAmount: "12.50",
                  completedAt: "2026-03-07T00:00:00.000Z"
                }
              });
          })
      )
    });

    const { billPeriodWorkflow } = await loadWorkflowModule();
    void billPeriodWorkflow({
      billId: "bill_001",
      currency: "USD",
      periodStart: "2026-03-01T00:00:00Z",
      periodEnd: "2026-03-31T23:59:59Z"
    });

    const closeHandler = getHandler<{ requestId: string; billId: string }>("closeBill");
    const closePromise = closeHandler({ requestId: "close-1", billId: "bill_001" });

    await vi.waitFor(() => {
      expect(workflowMockState.activities.closeAndCompleteBill).toHaveBeenCalledTimes(1);
    });

    const addHandler = getHandler<{
      requestId: string;
      billId: string;
      description: string;
      amount: string;
      currency: "USD";
    }>("addLineItem");

    await expect(
      addHandler({
        requestId: "add-2",
        billId: "bill_001",
        description: "Late Fee",
        amount: "1.00",
        currency: "USD"
      })
    ).rejects.toMatchObject({
      message: "bill is no longer open for mutations"
    });

    releaseLifecycle();
    await closePromise;
  });

  test("auto-closes at period end and runs lifecycle once", async () => {
    workflowMockState.setSleep(async () => undefined);
    const closeAndCompleteBill = vi.fn(async () => ({
      close: buildCloseResponse(),
      complete: {
        billId: "bill_001",
        status: "COMPLETED" as const,
        totalAmount: "12.50",
        completedAt: "2026-03-07T00:00:00.000Z"
      }
    }));
    workflowMockState.setActivities({
      ...workflowMockState.activities,
      closeAndCompleteBill
    });

    const { billPeriodWorkflow } = await loadWorkflowModule();
    const result = await billPeriodWorkflow({
      billId: "bill_001",
      currency: "USD",
      periodStart: "2026-03-01T00:00:00Z",
      periodEnd: "2026-03-31T23:59:59Z"
    });

    expect(result).toEqual({
      billId: "bill_001",
      status: "COMPLETED",
      totalAmount: "12.50",
      completedAt: "2026-03-07T00:00:00.000Z"
    });
    expect(closeAndCompleteBill).toHaveBeenCalledTimes(1);
  });
});
