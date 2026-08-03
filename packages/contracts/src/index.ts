import {
  CLASSIFICATION_TYPES,
  type Classification,
  type FeedbackInput,
  type Priority,
  type SelectedElement
} from "../../domain/src/index.ts";
import { createHash } from "node:crypto";
import { z } from "zod";

const BoundingBoxSchema = z.object({
  x: z.number().finite().min(-20_000).max(20_000),
  y: z.number().finite().min(-20_000).max(20_000),
  width: z.number().finite().min(0).max(20_000),
  height: z.number().finite().min(0).max(20_000)
}).strict();

export const SelectedElementSchema = z.object({
  tagName: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(100).optional(),
  accessibleName: z.string().trim().min(1).max(300).optional(),
  textPreview: z.string().trim().min(1).max(300).optional(),
  attributes: z.record(z.string().max(80), z.string().max(300)).default({}),
  testId: z.string().trim().min(1).max(200).optional(),
  feedbackId: z.string().trim().min(1).max(200).optional(),
  cssPath: z.string().trim().min(1).max(1_000).optional(),
  boundingBox: BoundingBoxSchema,
  ancestorSummary: z.array(z.object({
    tagName: z.string().trim().min(1).max(80),
    role: z.string().trim().min(1).max(100).optional(),
    testId: z.string().trim().min(1).max(200).optional()
  }).strict()).max(8).default([])
}).strict();

export const FeedbackPayloadSchema = z.object({
  clientFeedbackId: z.uuid(),
  comment: z.string().trim().min(1).max(2_000),
  page: z.object({
    url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "page.url must use http or https"),
    path: z.string().startsWith("/").max(500),
    title: z.string().trim().min(1).max(300),
    referrer: z.url().max(2_000).optional()
  }).strict(),
  environment: z.enum(["development", "staging"]),
  viewport: z.object({
    width: z.number().int().min(240).max(8_000),
    height: z.number().int().min(240).max(8_000),
    devicePixelRatio: z.number().min(0.5).max(4)
  }).strict(),
  selectedElement: SelectedElementSchema,
  client: z.object({ sdkVersion: z.string().min(1).max(100), userAgent: z.string().max(500).optional() }).strict(),
  appRevision: z.string().max(200).optional(),
  screenshot: z.object({ mimeType: z.enum(["image/png", "image/webp"]), base64: z.string().min(1).max(7_000_000) }).strict().optional()
}).strict();

export const ClassificationSchema = z.object({
  type: z.enum(CLASSIFICATION_TYPES),
  priority: z.enum(["low", "medium", "high", "critical"]),
  confidence: z.number().min(0).max(1),
  summary: z.string().trim().min(1).max(500),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(8),
  likelyAreas: z.array(z.string().trim().min(1).max(500)).max(8),
  needsClarification: z.boolean(),
  clarificationReason: z.string().trim().min(1).max(500).optional()
}).strict();

export type FeedbackPayload = z.infer<typeof FeedbackPayloadSchema>;

export class ContractValidationError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super(`Invalid feedback payload: ${issues.join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, field: string, min: number, max: number, issues: string[]): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    issues.push(`${field} must be a string with ${min}-${max} characters`);
    return "";
  }
  return value;
}

function optionalString(value: unknown, field: string, max: number, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, field, 1, max, issues);
}

function boundedNumber(value: unknown, field: string, min: number, max: number, issues: string[]): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    issues.push(`${field} must be a finite number between ${min} and ${max}`);
    return min;
  }
  return value;
}

function boundedInteger(value: unknown, field: string, min: number, max: number, issues: string[]): number {
  const parsed = boundedNumber(value, field, min, max, issues);
  if (!Number.isInteger(parsed)) issues.push(`${field} must be an integer`);
  return parsed;
}

function parsePage(value: unknown, issues: string[]) {
  if (!isRecord(value)) {
    issues.push("page is required");
    return { url: "", path: "", title: "" };
  }
  const url = stringValue(value.url, "page.url", 1, 2_000, issues);
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) issues.push("page.url must use http or https");
  } catch {
    issues.push("page.url must be a valid URL");
  }
  const path = stringValue(value.path, "page.path", 1, 500, issues);
  if (path && !path.startsWith("/")) issues.push("page.path must start with /");
  return {
    url,
    path,
    title: stringValue(value.title, "page.title", 1, 300, issues),
    referrer: optionalString(value.referrer, "page.referrer", 2_000, issues)
  };
}

function parseSelectedElement(value: unknown, issues: string[]): SelectedElement {
  if (!isRecord(value)) {
    issues.push("selectedElement is required");
    return {
      tagName: "unknown",
      attributes: {},
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      ancestorSummary: []
    };
  }
  const attributes: Record<string, string> = {};
  if (isRecord(value.attributes)) {
    for (const [key, raw] of Object.entries(value.attributes).slice(0, 32)) {
      if (typeof raw === "string") attributes[key.slice(0, 80)] = raw.slice(0, 300);
    }
  }
  const box = isRecord(value.boundingBox) ? value.boundingBox : {};
  const ancestors = Array.isArray(value.ancestorSummary) ? value.ancestorSummary : [];
  return {
    tagName: stringValue(value.tagName, "selectedElement.tagName", 1, 80, issues).toLowerCase(),
    role: optionalString(value.role, "selectedElement.role", 100, issues),
    accessibleName: optionalString(value.accessibleName, "selectedElement.accessibleName", 300, issues),
    textPreview: optionalString(value.textPreview, "selectedElement.textPreview", 300, issues),
    attributes,
    testId: optionalString(value.testId, "selectedElement.testId", 200, issues),
    feedbackId: optionalString(value.feedbackId, "selectedElement.feedbackId", 200, issues),
    cssPath: optionalString(value.cssPath, "selectedElement.cssPath", 1_000, issues),
    boundingBox: {
      x: boundedNumber(box.x, "selectedElement.boundingBox.x", -20_000, 20_000, issues),
      y: boundedNumber(box.y, "selectedElement.boundingBox.y", -20_000, 20_000, issues),
      width: boundedNumber(box.width, "selectedElement.boundingBox.width", 0, 20_000, issues),
      height: boundedNumber(box.height, "selectedElement.boundingBox.height", 0, 20_000, issues)
    },
    ancestorSummary: ancestors.slice(0, 8).flatMap((ancestor) => {
      if (!isRecord(ancestor)) return [];
      return [{
        tagName: stringValue(ancestor.tagName, "selectedElement.ancestorSummary.tagName", 1, 80, issues),
        role: optionalString(ancestor.role, "selectedElement.ancestorSummary.role", 100, issues),
        testId: optionalString(ancestor.testId, "selectedElement.ancestorSummary.testId", 200, issues)
      }];
    })
  };
}

function parseScreenshotPayload(value: unknown, issues: string[]) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push("screenshot must be an object");
    return undefined;
  }
  const mimeType = value.mimeType;
  if (mimeType !== "image/png" && mimeType !== "image/webp") issues.push("screenshot.mimeType is unsupported");
  const base64 = stringValue(value.base64, "screenshot.base64", 1, 7_000_000, issues);
  if (base64 && Buffer.byteLength(base64, "base64") > 5 * 1024 * 1024) issues.push("screenshot exceeds 5 MB");
  return { mimeType: mimeType === "image/webp" ? "image/webp" as const : "image/png" as const, base64 };
}

export function parseFeedbackInput(value: unknown, projectKey: string, idempotencyKey?: string): FeedbackInput {
  const issues: string[] = [];
  if (!isRecord(value)) throw new ContractValidationError(["body must be an object"]);
  const clientFeedbackId = stringValue(value.clientFeedbackId ?? idempotencyKey, "clientFeedbackId", 36, 80, issues);
  if (clientFeedbackId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientFeedbackId)) {
    issues.push("clientFeedbackId must be a UUID v4");
  }
  if (idempotencyKey && clientFeedbackId !== idempotencyKey) issues.push("Idempotency-Key must match clientFeedbackId");
  const comment = stringValue(value.comment, "comment", 1, 2_000, issues).trim();
  if (!comment) issues.push("comment cannot be empty");
  const environment = value.environment;
  if (environment !== "development" && environment !== "staging") issues.push("environment must be development or staging");
  const viewport = isRecord(value.viewport) ? {
    width: boundedInteger(value.viewport.width, "viewport.width", 240, 8_000, issues),
    height: boundedInteger(value.viewport.height, "viewport.height", 240, 8_000, issues),
    devicePixelRatio: boundedNumber(value.viewport.devicePixelRatio, "viewport.devicePixelRatio", 0.5, 4, issues)
  } : (issues.push("viewport is required"), { width: 0, height: 0, devicePixelRatio: 1 });
  const client = isRecord(value.client) ? {
    sdkVersion: stringValue(value.client.sdkVersion, "client.sdkVersion", 1, 100, issues),
    userAgent: optionalString(value.client.userAgent, "client.userAgent", 500, issues)
  } : (issues.push("client is required"), { sdkVersion: "" });
  const parsed: FeedbackInput = {
    clientFeedbackId,
    projectKey,
    comment,
    page: parsePage(value.page, issues),
    environment: environment === "staging" ? "staging" : "development",
    viewport,
    selectedElement: parseSelectedElement(value.selectedElement, issues),
    client,
    appRevision: optionalString(value.appRevision, "appRevision", 200, issues),
    screenshot: parseScreenshotPayload(value.screenshot, issues)
  };
  if (issues.length) throw new ContractValidationError(issues);
  return parsed;
}

export function parseClassification(value: unknown): Classification {
  const zodResult = ClassificationSchema.safeParse(value);
  if (zodResult.success) return zodResult.data;
  const issues: string[] = [];
  if (!isRecord(value)) throw new ContractValidationError(["classification must be an object"]);
  const type = value.type;
  if (!CLASSIFICATION_TYPES.includes(type as (typeof CLASSIFICATION_TYPES)[number])) issues.push("classification.type is invalid");
  const priority = value.priority;
  if (!["low", "medium", "high", "critical"].includes(priority as string)) issues.push("classification.priority is invalid");
  const confidence = value.confidence;
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) issues.push("classification.confidence must be between 0 and 1");
  const summary = stringValue(value.summary, "classification.summary", 1, 500, issues);
  const acceptanceCriteria = Array.isArray(value.acceptanceCriteria) ? value.acceptanceCriteria.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
  const likelyAreas = Array.isArray(value.likelyAreas) ? value.likelyAreas.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
  if (!Array.isArray(value.acceptanceCriteria)) issues.push("classification.acceptanceCriteria must be an array");
  if (!Array.isArray(value.likelyAreas)) issues.push("classification.likelyAreas must be an array");
  if (typeof value.needsClarification !== "boolean") issues.push("classification.needsClarification must be boolean");
  if (issues.length) throw new ContractValidationError(issues);
  return {
    type: type as Classification["type"],
    priority: priority as Priority,
    confidence: confidence as number,
    summary,
    acceptanceCriteria,
    likelyAreas,
    needsClarification: value.needsClarification as boolean,
    clarificationReason: typeof value.clarificationReason === "string" ? value.clarificationReason.slice(0, 500) : undefined
  };
}

export function detectScreenshotMime(bytes: Uint8Array): "image/png" | "image/webp" | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

export function parseScreenshot(input: { bytes: Buffer; declaredMime?: string }): { bytes: Buffer; mimeType: "image/png" | "image/webp"; sha256: string } {
  if (!input.bytes.length) throw new ContractValidationError(["screenshot is empty"]);
  if (input.bytes.byteLength > 5 * 1024 * 1024) throw new ContractValidationError(["screenshot exceeds 5 MB"]);
  const mimeType = detectScreenshotMime(input.bytes);
  if (!mimeType) throw new ContractValidationError(["screenshot content is not PNG or WebP"]);
  if (input.declaredMime && input.declaredMime !== mimeType) throw new ContractValidationError(["screenshot MIME does not match its content"]);
  return { bytes: input.bytes, mimeType, sha256: createHash("sha256").update(input.bytes).digest("hex") };
}

export function buildIssueTitle(summary: string): string {
  const clean = summary.replace(/[\r\n]+/g, " ").trim().slice(0, 100);
  return `[Feedback] ${clean || "Revisar feedback"}`;
}

export function buildIssueBody(input: FeedbackInput, classification: Classification, feedbackId: string): string {
  const criteria = classification.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- Revisar con una persona antes de implementar";
  const element = input.selectedElement.feedbackId || input.selectedElement.testId || input.selectedElement.cssPath || input.selectedElement.tagName;
  return [
    "## Contexto",
    "",
    `- Feedback interno: \`${feedbackId}\``,
    `- Comentario: ${input.comment}`,
    `- Página: ${input.page.url}`,
    `- Entorno: ${input.environment}`,
    `- Viewport: ${input.viewport.width}x${input.viewport.height} @${input.viewport.devicePixelRatio}x`,
    `- Elemento: \`${element}\``,
    `- Revisión de la app: ${input.appRevision || "no indicada"}`,
    "",
    "## Clasificación",
    "",
    `- Tipo: ${classification.type}`,
    `- Prioridad: ${classification.priority}`,
    `- Confianza: ${classification.confidence.toFixed(2)}`,
    "",
    "## Criterios de aceptación",
    "",
    criteria,
    "",
    "> El screenshot y los metadatos pueden contener información sensible. Verificar antes de compartir.",
    "",
    "El agente debe inspeccionar el repositorio y detenerse para revisión humana si no puede reproducir o delimitar el cambio."
  ].join("\n");
}
