import { test } from "vitest";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoSystem, fixtureFeedback } from "../packages/api/src/pipeline.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures/repo-basic");

test("vertical flow is idempotent and reaches a reviewable mock PR", async () => {
  const system = createDemoSystem(fixtureRoot);
  const input = fixtureFeedback();
  const first = system.ingest.ingest(input, "pk_demo_public_key", input.clientFeedbackId);
  const duplicate = system.ingest.ingest(input, "pk_demo_public_key", input.clientFeedbackId);
  assert.equal(first.statusCode, 202);
  assert.deepEqual(duplicate.body.feedbackId, first.body.feedbackId);
  assert.equal(system.queue.size, 1);
  await system.drain();
  const feedbackId = String(first.body.feedbackId);
  const record = system.store.getFeedback(feedbackId);
  assert.equal(record?.status, "pr_opened");
  assert.equal(system.github.issues.size, 1);
  assert.equal(system.github.pullRequests.size, 1);
  assert.match(record?.pullRequest?.branchName || "", /^feedback\//);
  assert.ok(record?.pullRequest?.validationSummary.results.some((result) => result.commandId === "test" && result.status === "passed"));
  assert.ok(system.store.events.some((event) => event.type === "feedback.issue_created"));
  assert.ok(system.store.events.some((event) => event.type === "feedback.pr_opened"));
});

test("ambiguous feedback creates an Issue but stops for human review", async () => {
  const system = createDemoSystem(fixtureRoot);
  const input = { ...fixtureFeedback(), clientFeedbackId: "00000000-0000-4000-8000-000000000003", comment: "Arreglar esto" };
  const accepted = system.ingest.ingest(input, "pk_demo_public_key", input.clientFeedbackId);
  await system.drain();
  const record = system.store.getFeedback(String(accepted.body.feedbackId));
  assert.equal(record?.status, "needs_human_review");
  assert.equal(system.github.issues.size, 1);
  assert.equal(system.github.pullRequests.size, 0);
});
