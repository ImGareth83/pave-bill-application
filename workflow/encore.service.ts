import { Service } from "encore.dev/service";
import { startWorkerInBackground } from "./src/worker";

// The workflow service owns Temporal bill-period orchestration.
void startWorkerInBackground();

export default new Service("workflow");
