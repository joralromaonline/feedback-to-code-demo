import { timingSafeEqual } from "node:crypto";
import {
  canTransition,
  newId,
  sha256,
  toPublicStatus,
  type AgentRunRecord,
  type Classification,
  type FeedbackInput,
  type FeedbackRecord,
  type FeedbackStatus,
  type ProjectRecord,
  type PullRequestRef,
  type ValidationReport
} from "../../domain/src/index.ts";
import type { DatabasePool } from "./client.ts";

function sameHash(first: string, second: string): boolean {
  const left = Buffer.from(first, "hex");
  const right = Buffer.from(second, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function rowToProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    publicIngestKeyHash: String(row.public_ingest_key_hash),
    githubInstallationId: row.github_installation_id ? Number(row.github_installation_id) : undefined,
    githubOwner: String(row.github_owner),
    githubRepo: String(row.github_repo),
    githubBaseBranch: String(row.github_base_branch),
    createdAt: new Date(String(row.created_at)).toISOString()
  } as ProjectRecord;
}

function rowToFeedback(row: Record<string, unknown>): FeedbackRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    clientFeedbackId: String(row.client_feedback_id),
    projectKey: "[stored-as-hash]",
    status: String(row.status) as FeedbackStatus,
    comment: String(row.comment),
    page: { url: String(row.page_url), path: String(row.page_path), title: String(row.page_title), referrer: row.page_referrer ? String(row.page_referrer) : undefined },
    environment: String(row.environment) as "development" | "staging",
    viewport: row.viewport_json as FeedbackInput["viewport"],
    selectedElement: row.selected_element_json as FeedbackInput["selectedElement"],
    client: row.client_json as FeedbackInput["client"],
    appRevision: row.app_revision ? String(row.app_revision) : undefined,
    classification: row.classification_json as Classification | undefined,
    issueNumber: row.github_issue_number ? Number(row.github_issue_number) : undefined,
    issueUrl: row.github_issue_url ? String(row.github_issue_url) : undefined,
    failureCode: row.failure_code ? String(row.failure_code) : undefined,
    failureMessage: row.failure_message ? String(row.failure_message) : undefined,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

export interface AttachmentRecord {
  id: string;
  projectId: string;
  feedbackId: string;
  storageKey?: string;
  mimeType?: string;
  byteSize?: number;
  sha256?: string;
  status: string;
}

export class PostgresFeedbackStore {
  readonly pool: DatabasePool;

  constructor(pool: DatabasePool) { this.pool = pool; }

  async seedProject(input: { id?: string; publicKey: string; name: string; githubInstallationId?: number; githubOwner: string; githubRepo: string; githubBaseBranch: string }): Promise<ProjectRecord> {
    const id = input.id || "proj_demo";
    const result = await this.pool.query(
      `INSERT INTO projects(id, name, public_ingest_key_hash, github_installation_id, github_owner, github_repo, github_base_branch)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, public_ingest_key_hash=EXCLUDED.public_ingest_key_hash,
       github_installation_id=EXCLUDED.github_installation_id, github_owner=EXCLUDED.github_owner, github_repo=EXCLUDED.github_repo,
       github_base_branch=EXCLUDED.github_base_branch, updated_at=now() RETURNING *`,
      [id, input.name, sha256(input.publicKey), input.githubInstallationId || null, input.githubOwner, input.githubRepo, input.githubBaseBranch]
    );
    return rowToProject(result.rows[0]);
  }

  async findProjectByPublicKey(publicKey: string): Promise<ProjectRecord | undefined> {
    const digest = sha256(publicKey);
    const result = await this.pool.query("SELECT * FROM projects");
    const row = result.rows.find((candidate) => sameHash(String(candidate.public_ingest_key_hash), digest));
    return row ? rowToProject(row) : undefined;
  }

  async getProject(id: string): Promise<ProjectRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM projects WHERE id=$1", [id]);
    return result.rows[0] ? rowToProject(result.rows[0]) : undefined;
  }

  async createFeedback(project: ProjectRecord, input: FeedbackInput): Promise<{ record: FeedbackRecord; created: boolean }> {
    const id = newId("fb");
    const inserted = await this.pool.query(
      `INSERT INTO feedback(id, project_id, client_feedback_id, status, comment, page_url, page_path, page_title, page_referrer,
       environment, viewport_json, selected_element_json, client_json, app_revision)
       VALUES($1,$2,$3,'received',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(project_id, client_feedback_id) DO NOTHING RETURNING *`,
      [id, project.id, input.clientFeedbackId, input.comment, input.page.url, input.page.path, input.page.title, input.page.referrer || null,
        input.environment, input.viewport, input.selectedElement, input.client, input.appRevision || null]
    );
    const created = Boolean(inserted.rowCount);
    const result = created ? inserted : await this.pool.query("SELECT * FROM feedback WHERE project_id=$1 AND client_feedback_id=$2", [project.id, input.clientFeedbackId]);
    const record = rowToFeedback(result.rows[0]);
    if (created) await this.appendEvent(record.id, "feedback.received", { status: "received" });
    return { record, created };
  }

  async getFeedback(id: string): Promise<FeedbackRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM feedback WHERE id=$1", [id]);
    if (!result.rows[0]) return undefined;
    const record = rowToFeedback(result.rows[0]);
    const pull = await this.pool.query("SELECT * FROM pull_requests WHERE feedback_id=$1", [id]);
    if (pull.rows[0]) {
      record.pullRequest = {
        number: Number(pull.rows[0].number), url: String(pull.rows[0].url), branchName: String(pull.rows[0].branch_name),
        headSha: String(pull.rows[0].head_sha), validationSummary: pull.rows[0].validation_summary_json as ValidationReport
      };
    }
    return record;
  }

  async transition(id: string, next: FeedbackStatus, payload: Record<string, unknown> = {}): Promise<FeedbackRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT * FROM feedback WHERE id=$1 FOR UPDATE", [id]);
      if (!result.rows[0]) throw new Error(`Feedback not found: ${id}`);
      const current = String(result.rows[0].status) as FeedbackStatus;
      if (current !== next && !canTransition(current, next)) throw new Error(`Invalid feedback transition ${current} -> ${next}`);
      if (current !== next) await client.query("UPDATE feedback SET status=$2, updated_at=now() WHERE id=$1", [id, next]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    await this.appendEvent(id, `feedback.${next}`, { status: next, ...payload });
    return (await this.getFeedback(id)) as FeedbackRecord;
  }

  async setClassification(id: string, classification: Classification): Promise<void> {
    await this.pool.query("UPDATE feedback SET classification_json=$2, updated_at=now() WHERE id=$1", [id, classification]);
  }

  async setIssue(id: string, issueNumber: number, issueUrl: string): Promise<void> {
    await this.pool.query("UPDATE feedback SET github_issue_number=$2, github_issue_url=$3, updated_at=now() WHERE id=$1", [id, issueNumber, issueUrl]);
  }

  async setFailure(id: string, code: string, message: string): Promise<void> {
    await this.pool.query("UPDATE feedback SET failure_code=$2, failure_message=$3, updated_at=now() WHERE id=$1", [id, code, message.slice(0, 500)]);
  }

  async clearFailure(id: string): Promise<void> {
    await this.pool.query("UPDATE feedback SET failure_code=NULL, failure_message=NULL, updated_at=now() WHERE id=$1", [id]);
  }

  async createAttachment(input: AttachmentRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO attachments(id, project_id, feedback_id, kind, storage_key, mime_type, byte_size, sha256, redaction_applied, status)
       VALUES($1,$2,$3,'screenshot',$4,$5,$6,$7,true,$8) ON CONFLICT(id) DO NOTHING`,
      [input.id, input.projectId, input.feedbackId, input.storageKey || null, input.mimeType || null, input.byteSize || null, input.sha256 || null, input.status]
    );
  }

  async getAttachment(id: string): Promise<AttachmentRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM attachments WHERE id=$1", [id]);
    const row = result.rows[0];
    return row ? { id: row.id, projectId: row.project_id, feedbackId: row.feedback_id, storageKey: row.storage_key, mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256, status: row.status } : undefined;
  }

  async listAttachments(feedbackId: string): Promise<AttachmentRecord[]> {
    const result = await this.pool.query("SELECT * FROM attachments WHERE feedback_id=$1 ORDER BY created_at", [feedbackId]);
    return result.rows.map((row) => ({ id: row.id, projectId: row.project_id, feedbackId: row.feedback_id, storageKey: row.storage_key, mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256, status: row.status }));
  }

  async createAgentRun(feedbackId: string, projectId: string, model?: string): Promise<AgentRunRecord> {
    const existing = await this.pool.query("SELECT * FROM agent_runs WHERE feedback_id=$1 AND status='running' ORDER BY created_at DESC LIMIT 1", [feedbackId]);
    if (existing.rows[0]) return { id: existing.rows[0].id, feedbackId, status: "running", startedAt: new Date(existing.rows[0].started_at).toISOString() };
    const id = newId("run");
    const result = await this.pool.query("INSERT INTO agent_runs(id,project_id,feedback_id,status,model) VALUES($1,$2,$3,'running',$4) RETURNING *", [id, projectId, feedbackId, model || null]);
    await this.appendEvent(feedbackId, "agent_run.created", { agentRunId: id }, id);
    return { id, feedbackId, status: "running", startedAt: new Date(result.rows[0].started_at).toISOString() };
  }

  async updateAgentRun(id: string, update: { branchName?: string; baseSha?: string }): Promise<void> {
    await this.pool.query("UPDATE agent_runs SET branch_name=COALESCE($2,branch_name), base_sha=COALESCE($3,base_sha), updated_at=now() WHERE id=$1", [id, update.branchName || null, update.baseSha || null]);
  }

  async finishAgentRun(id: string, update: { status: AgentRunRecord["status"]; summary?: string; validationReport?: ValidationReport; blockedReason?: string }): Promise<void> {
    const result = await this.pool.query(
      "UPDATE agent_runs SET status=$2, summary=$3, validation_summary_json=$4, blocked_reason=$5, finished_at=now(), updated_at=now() WHERE id=$1 RETURNING feedback_id",
      [id, update.status, update.summary || null, update.validationReport || null, update.blockedReason || null]
    );
    if (result.rows[0]) await this.appendEvent(result.rows[0].feedback_id, "agent_run.finished", { agentRunId: id, status: update.status }, id);
  }

  async setPullRequest(feedbackId: string, projectId: string, agentRunId: string, pullRequest: PullRequestRef): Promise<void> {
    await this.pool.query(
      `INSERT INTO pull_requests(id,project_id,feedback_id,agent_run_id,number,url,branch_name,head_sha,validation_summary_json,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'open') ON CONFLICT(feedback_id) DO UPDATE SET
       number=EXCLUDED.number,url=EXCLUDED.url,branch_name=EXCLUDED.branch_name,head_sha=EXCLUDED.head_sha,
       validation_summary_json=EXCLUDED.validation_summary_json,status='open',updated_at=now()`,
      [newId("pr"), projectId, feedbackId, agentRunId, pullRequest.number, pullRequest.url, pullRequest.branchName, pullRequest.headSha, pullRequest.validationSummary]
    );
  }

  async appendEvent(feedbackId: string, type: string, payload: Record<string, unknown>, agentRunId?: string): Promise<void> {
    const feedback = await this.pool.query("SELECT project_id FROM feedback WHERE id=$1", [feedbackId]);
    if (!feedback.rows[0]) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [feedbackId]);
      const sequence = await client.query("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM agent_events WHERE feedback_id=$1", [feedbackId]);
      await client.query(
        "INSERT INTO agent_events(id,project_id,feedback_id,agent_run_id,sequence,event_type,safe_payload_json) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [newId("evt"), feedback.rows[0].project_id, feedbackId, agentRunId || null, Number(sequence.rows[0].next), type, payload]
      );
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async publicView(id: string): Promise<Record<string, unknown> | undefined> {
    const record = await this.getFeedback(id);
    if (!record) return undefined;
    return { feedbackId: record.id, status: toPublicStatus(record.status), issueUrl: record.issueUrl, pullRequestUrl: record.pullRequest?.url, requestable: ["needs_human_review", "failed"].includes(record.status) };
  }

  async registerWebhookDelivery(id: string, eventName: string, action?: string, projectId?: string): Promise<boolean> {
    const result = await this.pool.query(
      "INSERT INTO webhook_deliveries(id,project_id,event_name,action) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING id",
      [id, projectId || null, eventName, action || null]
    );
    return Boolean(result.rowCount);
  }

  async updatePullRequestFromWebhook(input: { owner: string; repo: string; number: number; status: "open" | "closed" | "merged" }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE pull_requests pr SET status=$4,updated_at=now() FROM projects p WHERE pr.project_id=p.id AND p.github_owner=$1 AND p.github_repo=$2 AND pr.number=$3 RETURNING pr.feedback_id`,
      [input.owner, input.repo, input.number, input.status]
    );
    if (result.rows[0] && input.status !== "open") {
      const next = input.status === "merged" ? "merged" : "closed";
      await this.transition(result.rows[0].feedback_id, next);
    }
  }

  async operationalView(id: string): Promise<Record<string, unknown> | undefined> {
    const feedback = await this.getFeedback(id);
    if (!feedback) return undefined;
    const [attachments, runs] = await Promise.all([
      this.listAttachments(id),
      this.pool.query("SELECT id,status,base_sha,branch_name,model,started_at,finished_at,summary,blocked_reason,validation_summary_json FROM agent_runs WHERE feedback_id=$1 ORDER BY created_at DESC", [id])
    ]);
    const { projectKey: _projectKey, ...safeFeedback } = feedback;
    return {
      feedback: safeFeedback,
      attachments: attachments.map(({ storageKey: _storageKey, ...attachment }) => attachment),
      agentRuns: runs.rows
    };
  }

  async metrics(): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status IN ('pr_opened','merged','closed'))::int AS pr_opened,
       COUNT(*) FILTER (WHERE status='needs_human_review')::int AS needs_human_review,
       COUNT(*) FILTER (WHERE status IN ('failed','classification_failed','blocked'))::int AS failed_or_blocked,
       COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at-created_at))*1000) FILTER (WHERE status IN ('pr_opened','merged','closed')),0)::float8 AS average_time_to_pr_ms
       FROM feedback`
    );
    const row = result.rows[0];
    const total = Number(row.total);
    return {
      total,
      prOpened: Number(row.pr_opened),
      prOpenedRate: total ? Number(row.pr_opened) / total : 0,
      needsHumanReview: Number(row.needs_human_review),
      failedOrBlocked: Number(row.failed_or_blocked),
      averageTimeToPrMs: Number(row.average_time_to_pr_ms)
    };
  }

  async deleteFeedback(id: string): Promise<{ deleted: boolean; storageKeys: string[] }> {
    const attachments = await this.listAttachments(id);
    const result = await this.pool.query("DELETE FROM feedback WHERE id=$1 RETURNING id", [id]);
    return { deleted: Boolean(result.rowCount), storageKeys: attachments.flatMap((attachment) => attachment.storageKey ? [attachment.storageKey] : []) };
  }

  async health(): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  }
}
