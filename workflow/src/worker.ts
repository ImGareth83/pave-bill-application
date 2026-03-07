import { NativeConnection, Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";

import { billActivities } from "./activities/bill-activities";

const taskQueue = process.env.TEMPORAL_TASK_QUEUE?.trim() || "billing-periods";
const address = process.env.TEMPORAL_ADDRESS?.trim() || "localhost:7233";
const apiKey = process.env.TEMPORAL_API_KEY?.trim() || undefined;

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({
    address,
    apiKey,
    tls: apiKey ? true : undefined
  });
  const workflowsPath = fileURLToPath(new URL("./workflows/bill-period.ts", import.meta.url));

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE?.trim() || "default",
    taskQueue,
    workflowsPath,
    activities: billActivities
  });

  await worker.run();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
