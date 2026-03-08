export function temporalTaskQueue(): string {
  return requiredEnv("TEMPORAL_TASK_QUEUE");
}

export function temporalAddress(): string {
  return requiredEnv("TEMPORAL_ADDRESS");
}

export function temporalNamespace(): string {
  return requiredEnv("TEMPORAL_NAMESPACE");
}

export function temporalApiKey(): string | undefined {
  const value = process.env.TEMPORAL_API_KEY?.trim();
  return value ? value : undefined;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
