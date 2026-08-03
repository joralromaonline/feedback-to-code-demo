import { createHash, randomUUID } from "node:crypto";

export const FEEDBACK_STATUSES = [
  "received",
  "classifying",
  "classified",
  "issue_created",
  "queued",
  "agent_running",
  "validating",
  "pr_opened",
  "merged",
  "closed",
  "needs_human_review",
  "blocked",
  "failed",
  "classification_failed"
] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const PUBLIC_FEEDBACK_STATUSES = [
  "received",
  "processing",
  "issue_created",
  "pr_opened",
  "blocked",
  "failed"
] as const;

export type PublicFeedbackStatus = (typeof PUBLIC_FEEDBACK_STATUSES)[number];

export const CLASSIFICATION_TYPES = [
  "bug",
  "visual",
  "content",
  "accessibility",
  "performance",
  "feature",
  "unknown"
] as const;

export type ClassificationType = (typeof CLASSIFICATION_TYPES)[number];
export type Priority = "low" | "medium" | "high" | "critical";

export interface Classification {
  type: ClassificationType;
  priority: Priority;
  confidence: number;
  summary: string;
  acceptanceCriteria: string[];
  likelyAreas: string[];
  needsClarification: boolean;
  clarificationReason?: string;
}

export interface Viewport {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface SelectedElement {
  tagName: string;
  role?: string;
  accessibleName?: string;
  textPreview?: string;
  attributes: Record<string, string>;
  testId?: string;
  feedbackId?: string;
  cssPath?: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  ancestorSummary: Array<{ tagName: string; role?: string; testId?: string }>;
}

export interface PageContext {
  url: string;
  path: string;
  title: string;
  referrer?: string;
}

export interface ClientContext {
  sdkVersion: string;
  userAgent?: string;
}

export interface FeedbackInput {
  clientFeedbackId: string;
  projectKey: string;
  comment: string;
  page: PageContext;
  environment: "development" | "staging";
  viewport: Viewport;
  selectedElement: SelectedElement;
  client: ClientContext;
  appRevision?: string;
  screenshot?: { mimeType: "image/png" | "image/webp"; base64: string };
}

export interface FeedbackRecord extends FeedbackInput {
  id: string;
  projectId: string;
  status: FeedbackStatus;
  classification?: Classification;
  issueNumber?: number;
  issueUrl?: string;
  pullRequest?: PullRequestRef;
  failureCode?: string;
  failureMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  publicIngestKeyHash: string;
  githubInstallationId?: number;
  githubOwner: string;
  githubRepo: string;
  githubBaseBranch: string;
  createdAt: string;
}

export interface IssueRef {
  number: number;
  url: string;
}

export interface BranchRef {
  name: string;
  baseSha: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
  branchName: string;
  headSha: string;
  validationSummary: ValidationReport;
}

export type ValidationStatus = "passed" | "failed" | "timed_out" | "not_configured";

export interface ValidationResult {
  commandId: "lint" | "typecheck" | "test" | "build" | "playwright";
  status: ValidationStatus;
  exitCode?: number;
  durationMs: number;
  output?: string;
  reason?: string;
}

export interface ValidationReport {
  generatedAt: string;
  results: ValidationResult[];
  changedFiles: string[];
  diffStat: string;
  visualCheck: "not_reproducible" | "pass" | "fail";
}

export interface AgentRunRecord {
  id: string;
  feedbackId: string;
  status: "running" | "completed" | "needs_human_review" | "failed";
  branchName?: string;
  baseSha?: string;
  summary?: string;
  validationReport?: ValidationReport;
  startedAt: string;
  finishedAt?: string;
}

export interface AgentEvent {
  id: string;
  feedbackId: string;
  type: string;
  sequence: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "feedback";
}

const TRANSITIONS: Record<FeedbackStatus, readonly FeedbackStatus[]> = {
  received: ["classifying", "failed"],
  classifying: ["classified", "classification_failed", "failed"],
  classified: ["issue_created", "needs_human_review", "failed"],
  issue_created: ["queued", "needs_human_review", "failed"],
  queued: ["agent_running", "needs_human_review", "failed"],
  agent_running: ["validating", "needs_human_review", "blocked", "failed"],
  validating: ["pr_opened", "needs_human_review", "blocked", "failed"],
  pr_opened: ["merged", "closed", "failed"],
  merged: [],
  closed: [],
  needs_human_review: [],
  blocked: ["queued", "failed"],
  failed: ["queued"],
  classification_failed: ["classifying", "failed"]
};

export function canTransition(from: FeedbackStatus, to: FeedbackStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function toPublicStatus(status: FeedbackStatus): PublicFeedbackStatus {
  if (status === "received") return "received";
  if (status === "issue_created") return "issue_created";
  if (status === "pr_opened" || status === "merged" || status === "closed") return "pr_opened";
  if (status === "blocked" || status === "needs_human_review") return "blocked";
  if (status === "failed" || status === "classification_failed") return "failed";
  return "processing";
}
