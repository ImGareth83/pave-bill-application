export type BillStatus = "OPEN" | "CLOSED" | "COMPLETED";
export type WorkflowPhase = "OPEN" | "CLOSING" | "COMPLETED";
export type LineItemStatus = "ADDED" | "REJECTED";
export type Currency = "USD" | "GEL";

export interface BillWorkflowInput {
  billId: string;
  currency: Currency;
  periodStart: string;
  periodEnd: string;
}

export interface AddLineItemInput {
  requestId: string;
  billId: string;
  description: string;
  amount: string;
  currency: Currency;
}

export interface AddLineItemResponse {
  lineItemId: string;
  billId: string;
  description: string;
  amount: string;
  status: "ADDED";
  createdAt: string;
}

export interface RejectLineItemInput {
  requestId: string;
  billId: string;
  lineItemId: string;
  reason: string;
}

export interface RejectLineItemResponse {
  lineItemId: string;
  billId: string;
  status: "REJECTED";
  rejectedAt: string;
  reason: string;
}

export interface CloseBillInput {
  requestId: string;
  billId: string;
}

export interface CloseBillResponse {
  billId: string;
  status: "CLOSED";
  closedAt: string;
}

export interface CompleteBillInput {
  billId: string;
}

export interface CompleteBillResponse {
  billId: string;
  status: "COMPLETED";
  totalAmount: string;
  completedAt: string;
}

export interface BillRow {
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

export interface LineItemRow {
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

export interface PersistedLifecycleResult {
  close: CloseBillResponse;
  complete: CompleteBillResponse;
}

export interface IdempotencyRow {
  request_hash: string;
  response_json: unknown | null;
  state?: "PENDING" | "COMPLETED";
}
