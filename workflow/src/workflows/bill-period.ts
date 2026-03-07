import {
  condition,
  defineUpdate,
  proxyActivities,
  setHandler,
  sleep
} from "@temporalio/workflow";

import {
  computeDelayUntil,
  validateCurrency,
  validatePeriod
} from "../domain";
import type {
  AddLineItemInput,
  AddLineItemResponse,
  BillWorkflowInput,
  CloseBillInput,
  CloseBillResponse,
  CompleteBillResponse,
  PersistedLifecycleResult,
  RejectLineItemInput,
  RejectLineItemResponse,
  WorkflowPhase
} from "../types";
import type { billActivities } from "../activities/bill-activities";
import { invalid } from "../errors";

const activities = proxyActivities<typeof billActivities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    maximumAttempts: 5,
    initialInterval: "1 second",
    backoffCoefficient: 2
  }
});

export const addLineItemUpdate = defineUpdate<AddLineItemResponse, [AddLineItemInput]>("addLineItem");
export const rejectLineItemUpdate = defineUpdate<RejectLineItemResponse, [RejectLineItemInput]>(
  "rejectLineItem"
);
export const closeBillUpdate = defineUpdate<CloseBillResponse, [CloseBillInput]>("closeBill");

interface ProcessedUpdate<T> {
  requestId: string;
  response: T;
}

interface RequestState<T> {
  completed: Map<string, ProcessedUpdate<T>>;
  inFlight: Map<string, Promise<T>>;
}

export async function billPeriodWorkflow(
  input: BillWorkflowInput
): Promise<CompleteBillResponse> {
  if (!input.billId.trim()) {
    invalid("InvalidBillId", "billId is required");
  }
  validateCurrency(input.currency);
  validatePeriod(input.periodStart, input.periodEnd);

  let phase: WorkflowPhase = "OPEN";
  let manualCloseRequested = false;
  let lifecycleResult: PersistedLifecycleResult | undefined;
  let lifecyclePromise: Promise<PersistedLifecycleResult> | undefined;

  const processedAdds = createRequestState<AddLineItemResponse>();
  const processedRejects = createRequestState<RejectLineItemResponse>();
  const processedCloses = createRequestState<CloseBillResponse>();

  setHandler(addLineItemUpdate, async (request) => {
    if (request.billId !== input.billId) {
      invalid("BillMismatch", "request billId does not match workflow billId");
    }
    ensureOpen(phase);

    return runRequest(processedAdds, request.requestId, async () => {
      return activities.addLineItem(request);
    });
  });

  setHandler(rejectLineItemUpdate, async (request) => {
    if (request.billId !== input.billId) {
      invalid("BillMismatch", "request billId does not match workflow billId");
    }
    ensureOpen(phase);

    return runRequest(processedRejects, request.requestId, async () => {
      return activities.rejectLineItem(request);
    });
  });

  setHandler(closeBillUpdate, async (request) => {
    if (request.billId !== input.billId) {
      invalid("BillMismatch", "request billId does not match workflow billId");
    }

    if (phase !== "OPEN") {
      invalid("BillNotOpen", "only OPEN bills can be closed");
    }

    return runRequest(processedCloses, request.requestId, async () => {
      manualCloseRequested = true;
      const result = await ensureLifecycle();
      return result.close;
    });
  });

  const delayMs = computeDelayUntil(input.periodEnd, Date.now());
  if (delayMs > 0) {
    await Promise.race([sleep(delayMs), condition(() => manualCloseRequested)]);
  }

  const result = await ensureLifecycle();
  return result.complete;

  async function ensureLifecycle(): Promise<PersistedLifecycleResult> {
    if (lifecycleResult) {
      return lifecycleResult;
    }

    if (!lifecyclePromise) {
      lifecyclePromise = (async () => {
        if (phase === "OPEN") {
          phase = "CLOSING";
        }

        const persisted = await activities.closeAndCompleteBill(input.billId);
        phase = "COMPLETED";
        lifecycleResult = persisted;
        return persisted;
      })();
    }

    return lifecyclePromise;
  }
}

function ensureOpen(phase: WorkflowPhase): void {
  if (phase !== "OPEN") {
    invalid("BillNotOpen", "bill is no longer open for mutations");
  }
}

function createRequestState<T>(): RequestState<T> {
  return {
    completed: new Map<string, ProcessedUpdate<T>>(),
    inFlight: new Map<string, Promise<T>>()
  };
}

async function runRequest<T>(
  state: RequestState<T>,
  requestId: string,
  fn: () => Promise<T>
): Promise<T> {
  const completed = state.completed.get(requestId);
  if (completed) {
    return completed.response;
  }

  const existingPromise = state.inFlight.get(requestId);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = (async () => {
    try {
      const response = await fn();
      state.completed.set(requestId, { requestId, response });
      return response;
    } finally {
      state.inFlight.delete(requestId);
    }
  })();

  state.inFlight.set(requestId, promise);
  return promise;
}
