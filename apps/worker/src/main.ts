import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoSystem, fixtureFeedback } from "../../../packages/api/src/pipeline.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));
const system = createDemoSystem(join(currentDir, "../../../tests/fixtures/repo-basic"));
const input = fixtureFeedback();
const accepted = system.ingest.ingest(input, "pk_demo_public_key", input.clientFeedbackId);
await system.drain();
const result = system.store.publicView(String(accepted.body.feedbackId));
console.log(JSON.stringify({ accepted, result, issueCount: system.github.issues.size, pullRequestCount: system.github.pullRequests.size }, null, 2));
