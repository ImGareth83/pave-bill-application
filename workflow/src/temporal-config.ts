import { secret } from "encore.dev/config";

const temporalAddressSecret = secret("TEMPORAL_ADDRESS");
const temporalApiKeySecret = secret("TEMPORAL_API_KEY");
const temporalNamespaceSecret = secret("TEMPORAL_NAMESPACE");
const temporalTaskQueueSecret = secret("TEMPORAL_TASK_QUEUE");

export function temporalTaskQueue(): string {
  return readRequiredSecret(temporalTaskQueueSecret);
}

export function temporalAddress(): string {
  return readRequiredSecret(temporalAddressSecret);
}

export function temporalNamespace(): string {
  return readRequiredSecret(temporalNamespaceSecret);
}

export function temporalApiKey(): string | undefined {
  try {
    return readRequiredSecret(temporalApiKeySecret);
  } catch (error) {
    if (isSecretNotSet(error)) {
      return undefined;
    }
    throw error;
  }
}

function readRequiredSecret(secretValue: () => string): string {
  const value = secretValue().trim();
  if (!value) {
    throw new Error(`${secretValue.name} is required`);
  }
  return value;
}

function isSecretNotSet(error: unknown): boolean {
  return error instanceof Error && error.message === "secret TEMPORAL_API_KEY is not set";
}
