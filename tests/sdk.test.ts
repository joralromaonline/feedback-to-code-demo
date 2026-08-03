import { test } from "vitest";
import assert from "node:assert/strict";
import { assertClientConfig, createFeedbackPayload, normalizeText, redactText } from "../packages/sdk/src/index.ts";

test("SDK payload is browser-safe and keeps server credentials out", () => {
  const config = { projectKey: "pk_demo_public_key", apiUrl: "http://localhost:3001", environment: "development" as const, enabled: true };
  assertClientConfig(config);
  const payload = createFeedbackPayload(config, {
    comment: "  Texto visible  ",
    page: { url: "http://localhost:3000/checkout", path: "/checkout", title: "Checkout" },
    viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
    selectedElement: { tagName: "button", attributes: {}, boundingBox: { x: 0, y: 0, width: 1, height: 1 }, ancestorSummary: [] }
  }, "00000000-0000-4000-8000-000000000002");
  assert.equal(payload.comment, "Texto visible");
  assert.equal("projectKey" in payload, false);
  assert.equal("OPENAI_API_KEY" in payload, false);
});

test("SDK normalizes and redacts text previews", () => {
  assert.equal(normalizeText("  hello   world "), "hello world");
  assert.equal(redactText("secret", ["input"]), "[REDACTED]");
});
