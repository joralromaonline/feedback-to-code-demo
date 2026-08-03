import { test } from "vitest";
import assert from "node:assert/strict";
import { ContractValidationError, parseFeedbackInput } from "../packages/contracts/src/index.ts";
import { fixtureFeedback } from "../packages/api/src/pipeline.ts";

test("contract accepts fixture feedback and preserves the semantic selector", () => {
  const input = parseFeedbackInput(fixtureFeedback(), "pk_demo_public_key", fixtureFeedback().clientFeedbackId);
  assert.equal(input.selectedElement.feedbackId, "checkout-submit");
  assert.equal(input.page.path, "/checkout");
});

test("contract rejects invalid URL, viewport and oversized screenshot", () => {
  const invalid = { ...fixtureFeedback(), page: { ...fixtureFeedback().page, url: "javascript:alert(1)" }, viewport: { width: 20, height: 20, devicePixelRatio: 9 }, screenshot: { mimeType: "image/png" as const, base64: "a".repeat(7_000_000) } };
  assert.throws(() => parseFeedbackInput(invalid, "pk_demo_public_key", invalid.clientFeedbackId), ContractValidationError);
});
