import { NativeConnection, Worker } from "@temporalio/worker";
import { fileURLToPath, pathToFileURL } from "node:url";

import { billActivities } from "./activities/bill-activities";

const taskQueue = process.env.TEMPORAL_TASK_QUEUE?.trim() || "billing-periods";
const address = process.env.TEMPORAL_ADDRESS?.trim() || "localhost:7233";
const apiKey = process.env.TEMPORAL_API_KEY?.trim() || undefined;
const namespace = process.env.TEMPORAL_NAMESPACE?.trim() || "default";
let workerStartPromise: Promise<void> | undefined;

export async function runWorker(): Promise<void> {
  console.info("starting temporal worker", {
    address,
    namespace,
    taskQueue
  });
  const connection = await NativeConnection.connect({
    address,
    apiKey,
    tls: apiKey ? true : undefined
  });
  console.info("connected to temporal", {
    address,
    namespace,
    taskQueue
  });
  const workflowsPath = fileURLToPath(new URL("./workflows/bill-period.ts", import.meta.url));

  console.info("creating temporal worker", {
    workflowsPath,
    namespace,
    taskQueue
  });
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath,
    activities: billActivities
  });

  console.info("temporal worker created", {
    namespace,
    taskQueue
  });
  console.info("temporal worker entering run loop", {
    namespace,
    taskQueue
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
