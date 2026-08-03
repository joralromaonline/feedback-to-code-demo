import { timingSafeEqual } from "node:crypto";
import {
  canTransition,
  newId,
  nowIso,
  sha256,
  toPublicStatus,
  type AgentEvent,
  type AgentRunRecord,
  type Classification,
  type FeedbackInput,
  type FeedbackRecord,
  type FeedbackStatus,
  type ProjectRecord,
  type PullRequestRef
} from "../../domain/src/index.ts";

export class InMemoryFeedbackStore {
  readonly projects = new Map<string, ProjectRecord>();
  readonly feedback = new Map<string, FeedbackRecord>();
  readonly feedbackByKey = new Map<string, string>();
  readonly events: AgentEvent[] = [];
  readonly agentRuns = new Map<string, AgentRunRecord>();
  private eventSequence = new Map<string, number>();

  registerProject(input: { publicKey: string; name: string; githubOwner: string; githubRepo: string; githubBaseBranch: string }): ProjectRecord {
    const project: ProjectRecord = {
      id: newId("proj"),
      name: input.name,
      publicIngestKeyHash: sha256(input.publicKey),
      githubOwner: input.githubOwner,
      githubRepo: input.githubRepo,
      githubBaseBranch: input.githubBaseBranch,
      createdAt: nowIso()
    };
    this.projects.set(project.id, project);
    return project;
  }

  findProjectByPublicKey(publicKey: string): ProjectRecord | undefined {
    const candidate = Buffer.from(sha256(publicKey), "hex");
    for (const project of this.projects.values()) {
      const expected = Buffer.from(project.publicIngestKeyHash, "hex");
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return project;
    }
    return undefined;
  }

  createFeedback(project: ProjectRecord, input: FeedbackInput): { record: FeedbackRecord; created: boolean } {
    const key = `${project.id}:${input.clientFeedbackId}`;
    const existingId = this.feedbackByKey.get(key);
    if (existingId) return { record: this.feedback.get(existingId) as FeedbackRecord, created: false };
    const timestamp = nowIso();
    const record: FeedbackRecord = {
      ...input,
      id: newId("fb"),
      projectId: project.id,
      status: "received",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.feedback.set(record.id, record);
    this.feedbackByKey.set(key, record.id);
    this.appendEvent(record.id, "feedback.received", { status: record.status });
    return { record, created: true };
  }

  getFeedback(id: string): FeedbackRecord | undefined { return this.feedback.get(id); }

  transition(id: string, next: FeedbackStatus, payload: Record<string, unknown> = {}): FeedbackRecord {
    const record = this.feedback.get(id);
    if (!record) throw new Error(`Feedback not found: ${id}`);
    if (record.status === next) return record;
    if (!canTransition(record.status, next)) throw new Error(`Invalid feedback transition ${record.status} -> ${next}`);
    record.status = next;
    record.updatedAt = nowIso();
    this.appendEvent(id, `feedback.${next}`, { status: next, ...payload });
    return record;
  }

  setClassification(id: string, classification: Classification): void {
    const record = this.feedback.get(id);
    if (!record) throw new Error(`Feedback not found: ${id}`);
    record.classification = classification;
    record.updatedAt = nowIso();
  }

  setIssue(id: string, issueNumber: number, issueUrl: string): void {
    const record = this.feedback.get(id);
    if (!record) throw new Error(`Feedback not found: ${id}`);
    record.issueNumber = issueNumber;
    record.issueUrl = issueUrl;
    record.updatedAt = nowIso();
  }

  setPullRequest(id: string, pullRequest: PullRequestRef): void {
    const record = this.feedback.get(id);
    if (!record) throw new Error(`Feedback not found: ${id}`);
    record.pullRequest = pullRequest;
    record.updatedAt = nowIso();
  }

  setFailure(id: string, failureCode: string, failureMessage: string): void {
    const record = this.feedback.get(id);
    if (!record) throw new Error(`Feedback not found: ${id}`);
    record.failureCode = failureCode;
    record.failureMessage = failureMessage.slice(0, 500);
    record.updatedAt = nowIso();
  }

  createAgentRun(feedbackId: string): AgentRunRecord {
    const existing = [...this.agentRuns.values()].find((run) => run.feedbackId === feedbackId && run.status === "running");
    if (existing) return existing;
    const run: AgentRunRecord = { id: newId("run"), feedbackId, status: "running", startedAt: nowIso() };
    this.agentRuns.set(run.id, run);
    this.appendEvent(feedbackId, "agent_run.created", { agentRunId: run.id });
    return run;
  }

  finishAgentRun(id: string, update: Partial<AgentRunRecord> & { status: AgentRunRecord["status"] }): AgentRunRecord {
    const run = this.agentRuns.get(id);
    if (!run) throw new Error(`Agent run not found: ${id}`);
    Object.assign(run, update, { finishedAt: nowIso() });
    this.appendEvent(run.feedbackId, "agent_run.finished", { agentRunId: id, status: run.status });
    return run;
  }

  appendEvent(feedbackId: string, type: string, payload: Record<string, unknown>): void {
    const sequence = (this.eventSequence.get(feedbackId) || 0) + 1;
    this.eventSequence.set(feedbackId, sequence);
    this.events.push({ id: newId("evt"), feedbackId, type, sequence, payload, createdAt: nowIso() });
  }

  publicView(id: string): Record<string, unknown> | undefined {
    const record = this.feedback.get(id);
    if (!record) return undefined;
    return {
      feedbackId: record.id,
      status: toPublicStatus(record.status),
      issueUrl: record.issueUrl,
      pullRequestUrl: record.pullRequest?.url,
      requestable: record.status === "needs_human_review" || record.status === "failed"
    };
  }
}
