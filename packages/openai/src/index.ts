import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ChatCompletionAssistantMessageParam, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { FunctionTool, ResponseInputItem } from "openai/resources/responses/responses";
import { ClassificationSchema, parseClassification } from "../../contracts/src/index.ts";
import type { Classification, FeedbackInput } from "../../domain/src/index.ts";

export interface ClassificationInput {
  feedback: FeedbackInput;
  feedbackId: string;
}

export interface LLMProvider {
  classify(input: ClassificationInput): Promise<Classification>;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (argumentsValue: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface CodeAgentInput {
  feedbackId: string;
  issueNumber: number;
  feedback: FeedbackInput;
  classification: Classification;
  repositoryInstructions: string;
  maxTurns?: number;
}

export interface CodeAgentResult {
  status: "completed" | "needs_human_review" | "failed";
  summary: string;
  reason?: string;
  turns: number;
}

export interface CodeAgentLLMProvider extends LLMProvider {
  runAgent(input: CodeAgentInput, toolDefinitions: AgentToolDefinition[]): Promise<CodeAgentResult>;
}

export function supportsCodeAgent(provider: LLMProvider): provider is CodeAgentLLMProvider {
  return typeof (provider as Partial<CodeAgentLLMProvider>).runAgent === "function";
}

export class MockLLMProvider implements LLMProvider {
  async classify(input: ClassificationInput): Promise<Classification> {
    const comment = input.feedback.comment.toLowerCase();
    const visual = /cort|pixel|color|aline|espaci|tamaño|visual|overflow|responsive/.test(comment);
    const bug = /no funciona|no navega|error|falla|bug|clic/.test(comment);
    const ambiguous = comment.length < 12 || /algo raro|revisar esto|arreglar/.test(comment);
    return parseClassification({
      type: visual ? "visual" : bug ? "bug" : ambiguous ? "unknown" : "content",
      priority: /urgente|bloquea|producción/.test(comment) ? "high" : "medium",
      confidence: ambiguous ? 0.4 : visual || bug ? 0.94 : 0.68,
      summary: input.feedback.comment.replace(/[\r\n]+/g, " ").slice(0, 120),
      acceptanceCriteria: visual
        ? ["El elemento seleccionado conserva su contenido visible en el viewport reportado", "Las validaciones disponibles pasan"]
        : ["El comportamiento descrito queda documentado y verificable"],
      likelyAreas: input.feedback.selectedElement.feedbackId || input.feedback.selectedElement.testId
        ? [input.feedback.selectedElement.feedbackId || input.feedback.selectedElement.testId || "selected-element"]
        : [input.feedback.page.path],
      needsClarification: ambiguous,
      clarificationReason: ambiguous ? "El comentario no describe un comportamiento o resultado esperado con suficiente precisión." : undefined
    });
  }
}

export interface OpenAIResponsesProviderOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  maxAgentTurns?: number;
}

/** Server-only adapter. It is never imported by the SDK package. */
export class OpenAIResponsesProvider implements CodeAgentLLMProvider {
  private client: OpenAI;
  private model: string;
  private reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  private maxAgentTurns: number;

  constructor(options: OpenAIResponsesProviderOptions = {}) {
    const apiKey = options.apiKey || process.env.OPENAI_API_KEY || "";
    this.model = options.model || process.env.OPENAI_MODEL || "";
    if (!apiKey || !this.model) throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required on the server");
    this.client = new OpenAI({ apiKey, timeout: options.timeoutMs || 120_000, fetch: options.fetchImpl });
    this.reasoningEffort = options.reasoningEffort || "medium";
    this.maxAgentTurns = options.maxAgentTurns || 40;
  }

  async classify(input: ClassificationInput): Promise<Classification> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.client.responses.parse({
        model: this.model,
          instructions: [
            "Classify internal UI feedback for an engineering team.",
            "Use type=visual for layout, styling, clipping, overflow, spacing, sizing, alignment, color, or responsive presentation problems, even when described as a defect.",
            "Use type=bug for functional behavior such as navigation, events, state, calculations, persistence, or data flow.",
            "Do not infer critical priority from emotional language alone.",
            "Set needsClarification when the expected behavior or reproduction context is insufficient.",
            "Return only the requested structured object."
          ].join("\n"),
          input: JSON.stringify({ feedbackId: input.feedbackId, feedback: { ...input.feedback, projectKey: undefined, screenshot: undefined } }),
          reasoning: { effort: this.reasoningEffort },
          text: { format: zodTextFormat(ClassificationSchema, "feedback_classification") },
          store: false
        });
        if (!response.output_parsed) throw new Error("OpenAI response did not contain parsed classification output");
        return ClassificationSchema.parse(response.output_parsed);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OpenAI classification failed");
  }

  async runAgent(input: CodeAgentInput, toolDefinitions: AgentToolDefinition[]): Promise<CodeAgentResult> {
    const maxTurns = Math.min(input.maxTurns || this.maxAgentTurns, this.maxAgentTurns);
    const finishTool: AgentToolDefinition = {
      name: "finish",
      description: "Finish the run. Use needs_human_review when the problem is ambiguous, not reproducible, requires a product decision, or cannot be validated.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["completed", "needs_human_review", "failed"] },
          summary: { type: "string", minLength: 1, maxLength: 1000 },
          reason: { type: "string", maxLength: 1000 }
        },
        required: ["status", "summary"]
      },
      execute: (argumentsValue) => argumentsValue
    };
    const allTools = [...toolDefinitions, finishTool];
    const tools: FunctionTool[] = allTools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: true }));
    const instructions = [
      "You are a controlled code-change agent.",
      "Inspect before editing. Make the smallest coherent change that resolves the feedback.",
      "Respect repository instructions. Never invent files, APIs, commands, test results, or screenshots.",
      "Use only the provided typed tools. You have no arbitrary shell access.",
      "Run available validations and inspect the final diff before finish.",
      "Do not expose or search for secrets. Do not modify files outside the workspace.",
      "Call finish exactly once. Use needs_human_review when evidence is insufficient."
    ].join("\n");
    const initialMessage = {
      role: "user" as const,
      content: JSON.stringify({
        feedbackId: input.feedbackId,
        issueNumber: input.issueNumber,
        feedback: { ...input.feedback, projectKey: undefined, screenshot: undefined },
        classification: input.classification,
        repositoryInstructions: input.repositoryInstructions.slice(0, 20_000)
      })
    };
    const conversation: ResponseInputItem[] = [initialMessage];
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const response = await this.client.responses.create({
        model: this.model,
        instructions,
        input: conversation,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        reasoning: { effort: this.reasoningEffort },
        text: { verbosity: "low" },
        store: false
      });
      conversation.push(...response.output as ResponseInputItem[]);
      const calls = response.output.filter((item) => item.type === "function_call");
      if (!calls.length) {
        return { status: "needs_human_review", summary: response.output_text || "Agent stopped without a finish call", reason: "missing_finish_tool_call", turns: turn };
      }
      for (const call of calls) {
        const tool = allTools.find((candidate) => candidate.name === call.name);
        if (!tool) throw new Error(`Model requested unknown tool: ${call.name}`);
        let argumentsValue: Record<string, unknown>;
        try { argumentsValue = JSON.parse(call.arguments) as Record<string, unknown>; }
        catch { argumentsValue = {}; }
        const output = await tool.execute(argumentsValue);
        conversation.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
        if (call.name === "finish") {
          const finishOutput = typeof output === "object" && output !== null ? output as Record<string, unknown> : {};
          const status = finishOutput.status;
          return {
            status: status === "completed" || status === "failed" ? status : "needs_human_review",
            summary: typeof finishOutput.summary === "string" ? finishOutput.summary : "Agent finished without a summary",
            reason: typeof finishOutput.reason === "string" ? finishOutput.reason : undefined,
            turns: turn
          };
        }
      }
    }
    return { status: "needs_human_review", summary: "Agent turn limit reached", reason: "max_turns_reached", turns: maxTurns };
  }
}

export interface NvidiaChatCompletionsProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  reasoningEffort?: "none" | "high" | "max";
  maxAgentTurns?: number;
  maxOutputTokens?: number;
  classificationTimeoutMs?: number;
  agentTimeoutMs?: number;
  onEvent?: (event: NvidiaProviderEvent) => void;
}

export type LLMProviderErrorCode = "timeout" | "rate_limited" | "authentication_failed" | "request_failed" | "invalid_output";

export class LLMProviderError extends Error {
  readonly code: LLMProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: LLMProviderErrorCode, message: string, retryable: boolean, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "LLMProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface NvidiaProviderEvent {
  event: "request.started" | "request.completed" | "request.failed" | "output.invalid" | "json_mode.fallback";
  operation: "classification" | "agent";
  attempt?: number;
  turn?: number;
  elapsedMs?: number;
  code?: LLMProviderErrorCode;
}

const NVIDIA_CLASSIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["bug", "visual", "content", "accessibility", "performance", "feature", "unknown"] },
    priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string", minLength: 1, maxLength: 500 },
    acceptanceCriteria: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 500 } },
    likelyAreas: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 500 } },
    needsClarification: { type: "boolean" },
    clarificationReason: { type: "string", minLength: 1, maxLength: 500 }
  },
  required: ["type", "priority", "confidence", "summary", "acceptanceCriteria", "likelyAreas", "needsClarification"]
} as const;

function parseJsonObject(content: string | null): Record<string, unknown> {
  if (!content) throw new Error("NVIDIA response did not contain text output");
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(normalized);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("NVIDIA response was not a JSON object");
  return parsed as Record<string, unknown>;
}

function parseNvidiaClassification(content: string | null, feedback: FeedbackInput): Classification {
  try {
    const parsed = parseJsonObject(content);
    if (typeof parsed.clarificationReason === "string" && !parsed.clarificationReason.trim()) delete parsed.clarificationReason;
    const classification = ClassificationSchema.parse(parsed);
    const comment = feedback.comment.toLowerCase();
    const hasVisualSignal = /\b(?:cortad[oa]?|truncad[oa]?|desbord|overflow|responsive|alineaci[oó]n|espaciado|layout|p[ií]xel(?:es)?|tamañ[oa])\b/.test(comment);
    const hasFunctionalSignal = /\b(?:no funciona|no navega|no guarda|no carga|error|falla|clic|click|estado|datos?)\b/.test(comment);
    if (hasVisualSignal && !hasFunctionalSignal && (classification.type === "bug" || classification.type === "unknown")) {
      return ClassificationSchema.parse({ ...classification, type: "visual" });
    }
    return classification;
  } catch (error) {
    if (error instanceof LLMProviderError) throw error;
    throw new LLMProviderError("invalid_output", "NVIDIA returned invalid structured classification output", false, { cause: error });
  }
}

function isJsonModeCompatibilityError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 400 || status === 422;
}

function normalizeNvidiaRequestError(error: unknown): LLMProviderError {
  if (error instanceof LLMProviderError) return error;
  const details = typeof error === "object" && error !== null ? error as { status?: unknown; name?: unknown; message?: unknown } : {};
  const status = typeof details.status === "number" ? details.status : undefined;
  const name = typeof details.name === "string" ? details.name : "";
  const message = typeof details.message === "string" ? details.message : "";
  if (status === 429) return new LLMProviderError("rate_limited", "NVIDIA rate limit reached", true, { cause: error });
  if (status === 401 || status === 403) return new LLMProviderError("authentication_failed", "NVIDIA authentication failed", false, { cause: error });
  if (/timeout|timed out|abort/i.test(`${name} ${message}`)) return new LLMProviderError("timeout", "NVIDIA request timed out", true, { cause: error });
  return new LLMProviderError("request_failed", "NVIDIA request failed", status === undefined || status >= 500, { cause: error });
}

function remainingRequestTimeout(deadline: number, requestTimeoutMs: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new LLMProviderError("timeout", "NVIDIA operation deadline exceeded", true);
  return Math.max(1, Math.min(requestTimeoutMs, remaining));
}

/** Server-only adapter for NVIDIA NIM's OpenAI-compatible Chat Completions endpoint. */
export class NvidiaChatCompletionsProvider implements CodeAgentLLMProvider {
  private client: OpenAI;
  private model: string;
  private reasoningEffort: "none" | "high" | "max";
  private maxAgentTurns: number;
  private maxOutputTokens: number;
  private requestTimeoutMs: number;
  private classificationTimeoutMs: number;
  private agentTimeoutMs: number;
  private jsonModeSupported: boolean | undefined;
  private onEvent: (event: NvidiaProviderEvent) => void;

  constructor(options: NvidiaChatCompletionsProviderOptions = {}) {
    const apiKey = options.apiKey || process.env.NVIDIA_API_KEY || "";
    const baseURL = options.baseUrl || process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
    this.model = options.model || process.env.NVIDIA_MODEL || "deepseek-ai/deepseek-v4-pro";
    if (!apiKey) throw new Error("NVIDIA_API_KEY is required on the server");
    this.requestTimeoutMs = options.timeoutMs || 120_000;
    this.client = new OpenAI({ apiKey, baseURL, timeout: this.requestTimeoutMs, maxRetries: 0, fetch: options.fetchImpl });
    this.reasoningEffort = options.reasoningEffort || "none";
    this.maxAgentTurns = options.maxAgentTurns || 12;
    this.maxOutputTokens = Math.min(Math.max(options.maxOutputTokens || 4_096, 1), 16_384);
    this.classificationTimeoutMs = options.classificationTimeoutMs || 90_000;
    this.agentTimeoutMs = options.agentTimeoutMs || 600_000;
    this.onEvent = options.onEvent || (() => undefined);
  }

  async classify(input: ClassificationInput): Promise<Classification> {
    const deadline = Date.now() + this.classificationTimeoutMs;
    let lastError: LLMProviderError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const correction = attempt === 0 ? "" : "\nThe previous response was invalid. Return exactly one JSON object matching the schema.";
      const messages: ChatCompletionMessageParam[] = [
        {
          role: "system",
          content: [
            "Classify internal UI feedback for an engineering team.",
            "Do not infer critical priority from emotional language alone.",
            "Set needsClarification when expected behavior or reproduction context is insufficient.",
            "Return only JSON, without Markdown or explanatory text.",
            `JSON Schema: ${JSON.stringify(NVIDIA_CLASSIFICATION_SCHEMA)}${correction}`
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({ feedbackId: input.feedbackId, feedback: { ...input.feedback, projectKey: undefined, screenshot: undefined } })
        }
      ];
      const body = {
        model: this.model,
        messages,
        temperature: 0,
        max_tokens: Math.min(this.maxOutputTokens, 2_048),
        reasoning_effort: this.reasoningEffort,
        stream: false as const
      };
      const started = Date.now();
      this.onEvent({ event: "request.started", operation: "classification", attempt: attempt + 1 });
      let completion;
      try {
        if (this.jsonModeSupported === false) {
          completion = await this.client.chat.completions.create(body, { timeout: remainingRequestTimeout(deadline, this.requestTimeoutMs), maxRetries: 0 });
        } else {
          try {
            completion = await this.client.chat.completions.create(
              { ...body, response_format: { type: "json_object" } },
              { timeout: remainingRequestTimeout(deadline, this.requestTimeoutMs), maxRetries: 0 }
            );
            this.jsonModeSupported = true;
          } catch (error) {
            if (!isJsonModeCompatibilityError(error)) throw error;
            this.jsonModeSupported = false;
            this.onEvent({ event: "json_mode.fallback", operation: "classification", attempt: attempt + 1, elapsedMs: Date.now() - started });
            completion = await this.client.chat.completions.create(body, { timeout: remainingRequestTimeout(deadline, this.requestTimeoutMs), maxRetries: 0 });
          }
        }
      } catch (error) {
        const normalized = normalizeNvidiaRequestError(error);
        this.onEvent({ event: "request.failed", operation: "classification", attempt: attempt + 1, elapsedMs: Date.now() - started, code: normalized.code });
        throw normalized;
      }
      this.onEvent({ event: "request.completed", operation: "classification", attempt: attempt + 1, elapsedMs: Date.now() - started });
      try {
        return parseNvidiaClassification(completion.choices[0]?.message.content || null, input.feedback);
      } catch (error) {
        lastError = error instanceof LLMProviderError ? error : new LLMProviderError("invalid_output", "NVIDIA returned invalid structured output", false, { cause: error });
        this.onEvent({ event: "output.invalid", operation: "classification", attempt: attempt + 1, elapsedMs: Date.now() - started, code: lastError.code });
      }
    }
    throw lastError || new LLMProviderError("invalid_output", "NVIDIA classification failed", false);
  }

  async runAgent(input: CodeAgentInput, toolDefinitions: AgentToolDefinition[]): Promise<CodeAgentResult> {
    const maxTurns = Math.min(input.maxTurns || this.maxAgentTurns, this.maxAgentTurns);
    const deadline = Date.now() + this.agentTimeoutMs;
    const finishTool: AgentToolDefinition = {
      name: "finish",
      description: "Finish the run. Use needs_human_review when the problem is ambiguous, not reproducible, requires a product decision, or cannot be validated.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["completed", "needs_human_review", "failed"] },
          summary: { type: "string", minLength: 1, maxLength: 1000 },
          reason: { type: "string", maxLength: 1000 }
        },
        required: ["status", "summary"]
      },
      execute: (argumentsValue) => argumentsValue
    };
    const allTools = [...toolDefinitions, finishTool];
    const tools: ChatCompletionTool[] = allTools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }));
    const instructions = [
      "You are a controlled code-change agent.",
      "Inspect before editing. Make the smallest coherent change that resolves the feedback.",
      "Respect repository instructions. Never invent files, APIs, commands, test results, or screenshots.",
      "Use only the provided typed tools, one tool call at a time. You have no arbitrary shell access.",
      "Run available validations and inspect the final diff before finish.",
      "Do not expose or search for secrets. Do not modify files outside the workspace.",
      "Call finish exactly once. Use needs_human_review when evidence is insufficient."
    ].join("\n");
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: instructions },
      {
        role: "user",
        content: JSON.stringify({
          feedbackId: input.feedbackId,
          issueNumber: input.issueNumber,
          feedback: { ...input.feedback, projectKey: undefined, screenshot: undefined },
          classification: input.classification,
          repositoryInstructions: input.repositoryInstructions.slice(0, 20_000)
        })
      }
    ];

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const started = Date.now();
      this.onEvent({ event: "request.started", operation: "agent", turn });
      let completion;
      try {
        completion = await this.client.chat.completions.create({
          model: this.model,
          messages,
          tools,
          tool_choice: "auto",
          temperature: 1,
          max_tokens: this.maxOutputTokens,
          reasoning_effort: this.reasoningEffort,
          stream: false
        }, { timeout: remainingRequestTimeout(deadline, this.requestTimeoutMs), maxRetries: 0 });
      } catch (error) {
        const normalized = normalizeNvidiaRequestError(error);
        this.onEvent({ event: "request.failed", operation: "agent", turn, elapsedMs: Date.now() - started, code: normalized.code });
        return { status: "failed", summary: `NVIDIA agent request failed: ${normalized.code}`, reason: normalized.code, turns: turn };
      }
      this.onEvent({ event: "request.completed", operation: "agent", turn, elapsedMs: Date.now() - started });
      const message = completion.choices[0]?.message;
      if (!message) return { status: "needs_human_review", summary: "NVIDIA returned no agent message", reason: "missing_agent_message", turns: turn };
      const functionCalls = (message.tool_calls || []).filter((call) => call.type === "function");
      const assistantMessage: ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
        role: "assistant",
        content: message.content,
        tool_calls: functionCalls
      };
      const reasoningContent = (message as unknown as { reasoning_content?: unknown }).reasoning_content;
      if (typeof reasoningContent === "string") assistantMessage.reasoning_content = reasoningContent;
      messages.push(assistantMessage);

      if (!functionCalls.length) {
        return { status: "needs_human_review", summary: message.content || "Agent stopped without a finish call", reason: "missing_finish_tool_call", turns: turn };
      }
      for (const call of functionCalls) {
        const tool = allTools.find((candidate) => candidate.name === call.function.name);
        if (!tool) throw new Error(`Model requested unknown tool: ${call.function.name}`);
        let argumentsValue: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(call.function.arguments);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Tool arguments must be an object");
          argumentsValue = parsed as Record<string, unknown>;
        } catch {
          throw new Error(`Model returned invalid arguments for tool: ${call.function.name}`);
        }
        const output = await tool.execute(argumentsValue);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) || "null" });
        if (call.function.name === "finish") {
          const finishOutput = typeof output === "object" && output !== null ? output as Record<string, unknown> : {};
          const status = finishOutput.status;
          return {
            status: status === "completed" || status === "failed" ? status : "needs_human_review",
            summary: typeof finishOutput.summary === "string" ? finishOutput.summary : "Agent finished without a summary",
            reason: typeof finishOutput.reason === "string" ? finishOutput.reason : undefined,
            turns: turn
          };
        }
      }
    }
    return { status: "needs_human_review", summary: "Agent turn limit reached", reason: "max_turns_reached", turns: maxTurns };
  }
}
