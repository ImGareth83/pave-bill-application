import type { Currency } from "./types";
import { invalid } from "./errors";

export function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    invalid("InvalidDate", `${field} must be a valid ISO-8601 date`);
  }
  return date;
}

export function validatePeriod(periodStart: string, periodEnd: string): void {
  const start = parseDate(periodStart, "periodStart");
  const end = parseDate(periodEnd, "periodEnd");
  if (end <= start) {
    invalid("InvalidPeriod", "periodEnd must be after periodStart");
  }
}

export function validateCurrency(currency: string): asserts currency is Currency {
  if (currency !== "USD" && currency !== "GEL") {
    invalid("InvalidCurrency", "currency must be USD or GEL");
  }
}

export function parseAmountToMinor(input: string): bigint {
  if (typeof input !== "string") {
    invalid("InvalidAmount", "amount must be a decimal string");
  }

  const value = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    invalid("InvalidAmount", "amount must be a positive decimal with max 2 digits");
  }

  const [wholePart, fractionPartRaw] = value.split(".");
  const fractionPart = (fractionPartRaw ?? "").padEnd(2, "0");
  const whole = BigInt(wholePart);
  const fraction = BigInt(fractionPart || "00");
  const minor = whole * 100n + fraction;

  if (minor <= 0n) {
    invalid("InvalidAmount", "amount must be greater than zero");
  }

  return minor;
}

export function formatMinor(amount: string | number | bigint): string {
  const minor = toBigInt(amount);
  const abs = minor < 0n ? -minor : minor;
  const cents = (abs % 100n).toString().padStart(2, "0");
  const units = (abs / 100n).toString();
  return `${minor < 0n ? "-" : ""}${units}.${cents}`;
}

export function toBigInt(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value);
}

export function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function normalizeText(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    invalid(`Invalid${capitalize(field)}`, `${field} is required`);
  }
  return normalized;
}

export function workflowIdForBill(billId: string): string {
  return `bill/${billId}`;
}

export function computeDelayUntil(periodEnd: string, nowMs: number): number {
  const endMs = parseDate(periodEnd, "periodEnd").getTime();
  return Math.max(0, endMs - nowMs);
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}
