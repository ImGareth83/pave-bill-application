import { ApplicationFailure } from "@temporalio/common";

import type {
  AddLineItemInput,
  AddLineItemResponse,
  CloseBillResponse,
  PersistedLifecycleResult,
  RejectLineItemInput,
  RejectLineItemResponse
} from "../types";

const backendBaseUrl = resolveBackendBaseUrl();

export const billActivities = {
  addLineItem,
  rejectLineItem,
  closeAndCompleteBill
};

export async function addLineItem(input: AddLineItemInput): Promise<AddLineItemResponse> {
  return callBackendApi<AddLineItemResponse>(
    `/workflow/bills/${encodeURIComponent(input.billId)}/line-items`,
    {
      method: "POST",
      body: {
        requestId: input.requestId,
        billId: input.billId,
        description: input.description,
        amount: input.amount,
        currency: input.currency
      }
    }
  );
}

export async function rejectLineItem(input: RejectLineItemInput): Promise<RejectLineItemResponse> {
  return callBackendApi<RejectLineItemResponse>(
    `/workflow/bills/${encodeURIComponent(input.billId)}/line-items/${encodeURIComponent(input.lineItemId)}/reject`,
    {
      method: "POST",
      body: {
        requestId: input.requestId,
        billId: input.billId,
        lineItemId: input.lineItemId,
        reason: input.reason
      }
    }
  );
}

export async function closeAndCompleteBill(billId: string): Promise<PersistedLifecycleResult> {
  return callBackendApi<PersistedLifecycleResult>(
    `/workflow/bills/${encodeURIComponent(billId)}/finalize`,
    {
      method: "POST",
      body: { billId }
    }
  );
}

async function callBackendApi<T>(
  path: string,
  options: {
    method: "POST";
    body: object;
  }
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${backendBaseUrl}${path}`, {
      method: options.method,
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(options.body)
    });
  } catch (error) {
    throw ApplicationFailure.retryable(
      `backend api request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      "BackendUnavailable"
    );
  }

  const payload = await parseJson(response);
  if (response.ok) {
    return payload as T;
  }

  const code = extractErrorCode(payload);
  const message = extractErrorMessage(payload, response.statusText);
  if (response.status >= 500) {
    throw ApplicationFailure.retryable(message, code ?? "BackendError");
  }

  throw ApplicationFailure.nonRetryable(message, mapFailureType(response.status), {
    code: code ?? `HTTP_${response.status}`
  });
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function extractErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const details = (payload as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return undefined;
  }

  const code = (details as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code : undefined;
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") {
    return fallback || "backend api request failed";
  }

  const message = (payload as { message?: unknown; error?: unknown }).message
    ?? (payload as { error?: unknown }).error;
  return typeof message === "string" && message.trim()
    ? message
    : fallback || "backend api request failed";
}

function mapFailureType(status: number): string {
  if (status === 404) {
    return "NotFound";
  }
  if (status === 409) {
    return "Conflict";
  }
  return "InvalidArgument";
}

function resolveBackendBaseUrl(): string {
  const configured = process.env.BACKEND_API_BASE_URL?.trim();
  if (!configured) {
    throw new Error("BACKEND_API_BASE_URL is required for workflow backend api calls");
  }

  return configured.replace(/\/+$/, "");
}
