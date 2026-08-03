import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getConfig } from "../packages/config/src/index.ts";

const config = getConfig();
const fixture = JSON.parse(await readFile(new URL("../tests/fixtures/feedback-visual-button-overflow.json", import.meta.url), "utf8")) as Record<string, unknown>;
const clientFeedbackId = randomUUID();
const payload = { ...fixture, clientFeedbackId };
const response = await fetch(`${config.PUBLIC_API_ORIGIN}/v1/feedback`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-feedback-project-key": config.PUBLIC_DEMO_PROJECT_KEY, "idempotency-key": clientFeedbackId },
  body: JSON.stringify(payload)
});
if (response.status !== 202) throw new Error(`Feedback ingest failed: ${response.status} ${await response.text()}`);
const accepted = await response.json() as { feedbackId: string };
let publicState: Record<string, unknown> = {};
const started = Date.now();
while (Date.now() - started < 90_000) {
  const statusResponse = await fetch(`${config.PUBLIC_API_ORIGIN}/v1/feedback/${accepted.feedbackId}`);
  publicState = await statusResponse.json() as Record<string, unknown>;
  if (["pr_opened", "blocked", "failed"].includes(String(publicState.status))) break;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
}
if (publicState.status !== "pr_opened") throw new Error(`Demo flow did not reach pr_opened: ${JSON.stringify(publicState)}`);
console.log(JSON.stringify({ ok: true, feedbackId: accepted.feedbackId, status: publicState.status, issueUrl: publicState.issueUrl, pullRequestUrl: publicState.pullRequestUrl }, null, 2));
