import { NativeConnection, Worker } from "@temporalio/worker";
import { fileURLToPath, pathToFileURL } from "node:url";

import { billActivities } from "./activities/bill-activities";

const taskQueue = process.env.TEMPORAL_TASK_QUEUE?.trim() || "billing-periods";
const address = process.env.TEMPORAL_ADDRESS?.trim() || "localhost:7233";
const apiKey = process.env.TEMPORAL_API_KEY?.trim() || undefined;
const namespace = process.env.TEMPORAL_NAMESPACE?.trim() || "default";
let workerStartPromise: Promise<void> | undefined;

export async function runWorker(): Promise<void> {
  const connection = await NativeConnection.connect({
    address,
    apiKey,
    tls: apiKey ? true : undefined
  });
  const workflowsPath = fileURLToPath(new URL("./workflows/bill-period.ts", import.meta.url));

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath,
    activities: billActivities
  });

  await worker.run();
}

export function startWorkerInBackground(): Promise<void> {
  if (process.env.NODE_ENV === "test" || process.env.DISABLE_TEMPORAL_WORKER === "1") {
    return Promise.resolve();
  }

  workerStartPromise ??= runWorker().catch((error) => {
    workerStartPromise = undefined;
    console.error("temporal worker exited", error);
    throw error;
  });

  return workerStartPromise;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectExecution()) {
  startWorkerInBackground().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
