import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
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
export class OpenAIResponsesProvider implements LLMProvider {
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
