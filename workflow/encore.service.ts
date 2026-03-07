import { Service } from "encore.dev/service";
import { startWorkerInBackground } from "./src/worker";

// The workflow service hosts the Temporal worker runtime for this app.
void startWorkerInBackground();

export default new Service("workflow");
