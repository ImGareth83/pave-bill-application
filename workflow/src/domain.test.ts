import { describe, expect, test } from "vitest";
import { ApplicationFailure } from "@temporalio/common";

import {
  computeDelayUntil,
  formatMinor,
  parseAmountToMinor,
  parseDate,
  validateCurrency,
  validatePeriod,
  workflowIdForBill
} from "./domain";

describe("domain helpers", () => {
  test("parseAmountToMinor stores decimal money in minor units", () => {
    expect(parseAmountToMinor("10.25")).toBe(1025n);
    expect(parseAmountToMinor("7")).toBe(700n);
  });

  test("parseAmountToMinor rejects malformed and zero amounts", () => {
    expect(() => parseAmountToMinor("0")).toThrow(ApplicationFailure);
    expect(() => parseAmountToMinor("-1.00")).toThrow(ApplicationFailure);
    expect(() => parseAmountToMinor("12.345")).toThrow(ApplicationFailure);
    expect(() => parseAmountToMinor("abc")).toThrow(ApplicationFailure);
  });

  test("formatMinor renders cents back to decimal strings", () => {
    expect(formatMinor(1025n)).toBe("10.25");
    expect(formatMinor("700")).toBe("7.00");
  });

  test("workflowIdForBill uses stable bill prefix", () => {
    expect(workflowIdForBill("bill_123")).toBe("bill/bill_123");
  });

  test("validateCurrency rejects unsupported currencies", () => {
    expect(() => validateCurrency("EUR")).toThrow(ApplicationFailure);
  });

  test("parseDate rejects invalid ISO strings", () => {
    expect(() => parseDate("not-a-date", "periodStart")).toThrow(ApplicationFailure);
  });

  test("validatePeriod rejects equal or reversed bounds", () => {
    expect(() =>
      validatePeriod("2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z")
    ).toThrow(ApplicationFailure);
    expect(() =>
      validatePeriod("2026-03-02T00:00:00Z", "2026-03-01T00:00:00Z")
    ).toThrow(ApplicationFailure);
  });

  test("computeDelayUntil returns the positive delay for a future period end", () => {
    expect(
      computeDelayUntil("2026-03-01T00:00:10Z", Date.parse("2026-03-01T00:00:00Z"))
    ).toBe(10_000);
  });

  test("computeDelayUntil never returns a negative value", () => {
    expect(computeDelayUntil("2026-03-01T00:00:00Z", Date.parse("2026-03-02T00:00:00Z"))).toBe(0);
  });
});
