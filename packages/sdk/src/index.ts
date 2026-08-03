import type { FeedbackInput, PageContext, SelectedElement, Viewport } from "../../domain/src/index.ts";

export interface FeedbackClientConfig {
  projectKey: string;
  apiUrl: string;
  environment: "development" | "staging";
  enabled: boolean;
  sdkVersion?: string;
  timeoutMs?: number;
}

export interface FeedbackDraft {
  comment: string;
  page: PageContext;
  viewport: Viewport;
  selectedElement: SelectedElement;
  appRevision?: string;
  screenshot?: { mimeType: "image/png" | "image/webp"; base64: string };
}

export interface FeedbackAcceptedResponse {
  feedbackId: string;
  status: "received";
  requestId: string;
}

export class FeedbackSubmissionError extends Error {
  retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "FeedbackSubmissionError";
    this.retryable = retryable;
  }
}

export function createClientFeedbackId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export type FeedbackClientPayload = Omit<FeedbackInput, "projectKey">;

export function createFeedbackPayload(config: FeedbackClientConfig, draft: FeedbackDraft, id = createClientFeedbackId()): FeedbackClientPayload {
  return {
    clientFeedbackId: id,
    comment: draft.comment.trim(),
    page: draft.page,
    environment: config.environment,
    viewport: draft.viewport,
    selectedElement: draft.selectedElement,
    client: {
      sdkVersion: config.sdkVersion || "0.1.0",
      userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent
    },
    appRevision: draft.appRevision,
    screenshot: draft.screenshot
  };
}

export function assertClientConfig(config: FeedbackClientConfig): void {
  if (!config.projectKey || config.projectKey.length > 200) throw new Error("projectKey is required");
  if (!config.apiUrl || !/^https?:\/\//.test(config.apiUrl)) throw new Error("apiUrl must use http or https");
  if (config.environment !== "development" && config.environment !== "staging") throw new Error("invalid environment");
}

export async function submitFeedback(
  config: FeedbackClientConfig,
  draft: FeedbackDraft,
  fetchImpl: typeof fetch = fetch,
  id = createClientFeedbackId()
): Promise<FeedbackAcceptedResponse> {
  assertClientConfig(config);
  if (!config.enabled) throw new FeedbackSubmissionError("Feedback is disabled", false);
  const payload = createFeedbackPayload(config, draft, id);
  const timeoutMs = config.timeoutMs ?? 10_000;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${config.apiUrl.replace(/\/$/, "")}/v1/feedback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-feedback-project-key": config.projectKey,
          "idempotency-key": id
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body as FeedbackAcceptedResponse;
      if (response.status >= 400 && response.status < 500) {
        const details = Array.isArray(body.issues)
          ? body.issues.slice(0, 3).map((issue: unknown) => {
              if (!issue || typeof issue !== "object") return "";
              const value = issue as { path?: unknown; message?: unknown };
              return `${typeof value.path === "string" && value.path ? `${value.path}: ` : ""}${typeof value.message === "string" ? value.message : ""}`;
            }).filter(Boolean).join("; ")
          : "";
        throw new FeedbackSubmissionError(`${body.error || "Feedback rejected"}${details ? ` (${details})` : ""}`, false);
      }
      throw new FeedbackSubmissionError(body.error || "Feedback service unavailable", true);
    } catch (error) {
      lastError = error;
      if (error instanceof FeedbackSubmissionError && !error.retryable) throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new FeedbackSubmissionError(lastError instanceof Error ? lastError.message : "Feedback submission failed", true);
}

export { selectElementSnapshot, normalizeText, redactText } from "./browser.ts";
