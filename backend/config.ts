import { secret } from "encore.dev/config";

const temporalApiKeySecret = secret("TEMPORAL_API_KEY");

export function temporalTaskQueue(): string {
  return process.env.TEMPORAL_TASK_QUEUE?.trim() || "billing-periods";
}

export function temporalAddress(): string {
  return requiredEnv("TEMPORAL_ADDRESS");
}

export function temporalNamespace(): string {
  return requiredEnv("TEMPORAL_NAMESPACE");
}

export function temporalApiKey(): string | undefined {
  try {
    const value = temporalApiKeySecret().trim();
    return value ? value : undefined;
  } catch (error) {
    if (isSecretNotSet(error)) {
      return undefined;
    }
    throw error;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function isSecretNotSet(error: unknown): boolean {
  return error instanceof Error && error.message === "secret TEMPORAL_API_KEY is not set";
}
