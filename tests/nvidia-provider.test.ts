import { describe, expect, test } from "vitest";
import { fixtureFeedback } from "../packages/api/src/pipeline.ts";
import type { Classification } from "../packages/domain/src/index.ts";
import { NvidiaChatCompletionsProvider } from "../packages/openai/src/index.ts";

function chatCompletion(message: Record<string, unknown>, finishReason = "stop"): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "deepseek-ai/deepseek-v4-pro",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const validClassification: Classification = {
  type: "visual",
  priority: "medium",
  confidence: 0.94,
  summary: "El botón de checkout corta su texto",
  acceptanceCriteria: ["El texto permanece visible en 1280 px"],
  likelyAreas: ["checkout-submit"],
  needsClarification: false
};

describe("NVIDIA Chat Completions provider", () => {
  test("classifies with validated JSON without exposing client secrets", async () => {
    const requestBodies: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBodies.push(String(init?.body || ""));
      return chatCompletion({ role: "assistant", content: JSON.stringify({ ...validClassification, type: "bug", clarificationReason: "" }) });
    };
    const provider = new NvidiaChatCompletionsProvider({ apiKey: "nvapi-test-only", fetchImpl });

    const classification = await provider.classify({ feedbackId: "feedback-1", feedback: fixtureFeedback() });

    expect(classification.type).toBe("visual");
    expect(classification.clarificationReason).toBeUndefined();
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toContain("deepseek-ai/deepseek-v4-pro");
    expect(requestBodies[0]).not.toContain("pk_demo_public_key");
    expect(requestBodies[0]).not.toContain("screenshot");
  });

  test("retries once when the model returns invalid JSON", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return chatCompletion({ role: "assistant", content: calls === 1 ? "not-json" : JSON.stringify(validClassification) });
    };
    const provider = new NvidiaChatCompletionsProvider({ apiKey: "nvapi-test-only", fetchImpl });

    await expect(provider.classify({ feedbackId: "feedback-2", feedback: fixtureFeedback() })).resolves.toMatchObject({ type: "visual" });
    expect(calls).toBe(2);
  });

  test("does not multiply HTTP retries inside the OpenAI-compatible client", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    };
    const provider = new NvidiaChatCompletionsProvider({ apiKey: "nvapi-test-only", fetchImpl });

    await expect(provider.classify({ feedbackId: "feedback-http-error", feedback: fixtureFeedback() }))
      .rejects.toMatchObject({ code: "request_failed", retryable: true });
    expect(calls).toBe(1);
  });

  test("aborts classification at its total deadline", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const provider = new NvidiaChatCompletionsProvider({ apiKey: "nvapi-test-only", fetchImpl, timeoutMs: 1_000, classificationTimeoutMs: 20 });

    await expect(provider.classify({ feedbackId: "feedback-timeout", feedback: fixtureFeedback() }))
      .rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(calls).toBe(1);
  });

  test("executes the typed finish tool through Chat Completions", async () => {
    const fetchImpl: typeof fetch = async () => chatCompletion({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_finish",
        type: "function",
        function: { name: "finish", arguments: JSON.stringify({ status: "completed", summary: "Cambio validado" }) }
      }]
    }, "tool_calls");
    const provider = new NvidiaChatCompletionsProvider({ apiKey: "nvapi-test-only", fetchImpl });

    const result = await provider.runAgent({
      feedbackId: "feedback-3",
      issueNumber: 7,
      feedback: fixtureFeedback(),
      classification: validClassification,
      repositoryInstructions: "Run the configured checks."
    }, []);

    expect(result).toEqual({ status: "completed", summary: "Cambio validado", reason: undefined, turns: 1 });
  });
});
