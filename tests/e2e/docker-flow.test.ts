import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

const enabled = process.env.RUN_DOCKER_E2E === "true";

test.skipIf(!enabled)("Docker stack processes SDK payload through API, queue, worker, Issue and PR", async () => {
  const apiUrl = process.env.PUBLIC_API_ORIGIN || "http://localhost:3001";
  const projectKey = process.env.PUBLIC_DEMO_PROJECT_KEY || "pk_demo_public_key_change_me";
  const internalToken = process.env.INTERNAL_SERVICE_TOKEN || "local_internal_token_change_before_deploy";
  const fixture = JSON.parse(await readFile(new URL("../fixtures/feedback-visual-button-overflow.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const clientFeedbackId = randomUUID();
  const payload = {
    ...fixture,
    clientFeedbackId,
    screenshot: {
      mimeType: "image/png",
      base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    }
  };
  const response = await fetch(`${apiUrl}/v1/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-feedback-project-key": projectKey, "idempotency-key": clientFeedbackId },
    body: JSON.stringify(payload)
  });
  expect(response.status).toBe(202);
  const accepted = await response.json() as { feedbackId: string };
  const duplicate = await fetch(`${apiUrl}/v1/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-feedback-project-key": projectKey, "idempotency-key": clientFeedbackId },
    body: JSON.stringify(payload)
  });
  expect(duplicate.status).toBe(202);
  expect((await duplicate.json() as { feedbackId: string }).feedbackId).toBe(accepted.feedbackId);
  let state: { status?: string; issueUrl?: string; pullRequestUrl?: string } = {};
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    const statusResponse = await fetch(`${apiUrl}/v1/feedback/${accepted.feedbackId}`);
    state = await statusResponse.json() as typeof state;
    if (["pr_opened", "blocked", "failed"].includes(state.status || "")) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  expect(state.status).toBe("pr_opened");
  expect(state.issueUrl).toMatch(/issues\/\d+$/);
  expect(state.pullRequestUrl).toMatch(/pull\/\d+$/);

  const internalHeaders = { authorization: `Bearer ${internalToken}` };
  const jobResponse = await fetch(`${apiUrl}/internal/jobs/${accepted.feedbackId}`, { headers: internalHeaders });
  expect(jobResponse.status).toBe(200);
  const job = await jobResponse.json() as { attachments?: Array<{ status?: string }>; agentRuns?: Array<{ status?: string }> };
  expect(job.attachments?.[0]?.status).toBe("stored");
  expect(job.agentRuns?.[0]?.status).toBe("completed");

  const metricsResponse = await fetch(`${apiUrl}/internal/metrics`, { headers: internalHeaders });
  expect(metricsResponse.status).toBe(200);
  expect((await metricsResponse.json() as { prOpened?: number }).prOpened).toBeGreaterThan(0);

  const deleteResponse = await fetch(`${apiUrl}/internal/feedback/${accepted.feedbackId}`, { method: "DELETE", headers: internalHeaders });
  expect(deleteResponse.status).toBe(200);
  expect((await fetch(`${apiUrl}/v1/feedback/${accepted.feedbackId}`)).status).toBe(404);
});
