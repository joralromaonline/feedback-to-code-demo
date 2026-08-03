import { fixtureFeedback } from "../packages/api/src/pipeline.ts";
import { getConfig } from "../packages/config/src/index.ts";
import { NvidiaChatCompletionsProvider } from "../packages/openai/src/index.ts";

const config = getConfig();
if (!config.NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY is missing from .env");

const provider = new NvidiaChatCompletionsProvider({
  apiKey: config.NVIDIA_API_KEY,
  baseUrl: config.NVIDIA_BASE_URL,
  model: config.NVIDIA_MODEL,
  timeoutMs: config.NVIDIA_TIMEOUT_MS,
  reasoningEffort: config.NVIDIA_REASONING_EFFORT,
  maxAgentTurns: 3,
  maxOutputTokens: Math.min(config.NVIDIA_MAX_OUTPUT_TOKENS, 4_096)
});

let inspectionCalls = 0;
const result = await provider.runAgent({
  feedbackId: "nvidia-tools-smoke-test",
  issueNumber: 1,
  feedback: fixtureFeedback(),
  classification: {
    type: "visual",
    priority: "medium",
    confidence: 0.95,
    summary: "Verificar llamadas a herramientas tipadas",
    acceptanceCriteria: ["La herramienta inspect_fixture se ejecuta antes de finish"],
    likelyAreas: ["checkout-submit"],
    needsClarification: false
  },
  repositoryInstructions: "This is a read-only smoke test. You must call inspect_fixture once, inspect its result, then call finish with status completed. Do not request any change.",
  maxTurns: 3
}, [{
  name: "inspect_fixture",
  description: "Required read-only smoke-test tool. Call it exactly once before finish.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  execute: () => {
    inspectionCalls += 1;
    return { path: "src/checkout.css", selectedElement: "checkout-submit", mode: "read-only" };
  }
}]);

if (inspectionCalls !== 1) throw new Error(`Expected one inspect_fixture call, received ${inspectionCalls}`);
if (result.status !== "completed") throw new Error(`Agent smoke test did not complete: ${result.reason || result.summary}`);

console.log(JSON.stringify({
  provider: "nvidia",
  model: config.NVIDIA_MODEL,
  toolCalls: inspectionCalls,
  status: result.status,
  turns: result.turns
}));
