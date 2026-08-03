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
  maxAgentTurns: config.NVIDIA_MAX_AGENT_TURNS,
  maxOutputTokens: config.NVIDIA_MAX_OUTPUT_TOKENS
});

const result = await provider.classify({ feedbackId: "nvidia-smoke-test", feedback: fixtureFeedback() });
console.log(JSON.stringify({
  provider: "nvidia",
  model: config.NVIDIA_MODEL,
  type: result.type,
  priority: result.priority,
  confidence: result.confidence,
  needsClarification: result.needsClarification
}));
