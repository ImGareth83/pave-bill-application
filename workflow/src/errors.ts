import { ApplicationFailure } from "@temporalio/common";

export function invalid(code: string, message: string): never {
  throw ApplicationFailure.nonRetryable(message, "InvalidArgument", { code });
}

export function notFound(code: string, message: string): never {
  throw ApplicationFailure.nonRetryable(message, "NotFound", { code });
}

export function conflict(code: string, message: string): never {
  throw ApplicationFailure.nonRetryable(message, "Conflict", { code });
}

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const maybeCode = (err as { code?: string }).code;
  return maybeCode === "23505";
}
