import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIssueBody, buildIssueTitle } from "../../contracts/src/index.ts";
import type { GitProvider } from "../../github/src/index.ts";
import type { LLMProvider } from "../../openai/src/index.ts";
import { slugify, type FeedbackRecord, type ValidationReport } from "../../domain/src/index.ts";
import { InMemoryFeedbackStore } from "../../api/src/store.ts";
import { WorkspaceTools } from "./tools.ts";

export interface AgentWorkerOptions {
  fixtureRoot: string;
  maxTurns?: number;
}

export class AgentWorker {
  private store: InMemoryFeedbackStore;
  private llm: LLMProvider;
  private git: GitProvider;
  private options: AgentWorkerOptions;

  constructor(store: InMemoryFeedbackStore, llm: LLMProvider, git: GitProvider, options: AgentWorkerOptions) {
    this.store = store;
    this.llm = llm;
    this.git = git;
    this.options = options;
  }

  async process(feedbackId: string): Promise<void> {
    const feedback = this.store.getFeedback(feedbackId);
    if (!feedback) throw new Error(`Feedback not found: ${feedbackId}`);
    if (feedback.pullRequest || feedback.status === "needs_human_review") return;
    if (!feedback.classification) {
      this.store.transition(feedbackId, "classifying");
      try {
        const classification = await this.llm.classify({ feedback, feedbackId });
        this.store.setClassification(feedbackId, classification);
        this.store.transition(feedbackId, "classified", { type: classification.type, confidence: classification.confidence });
      } catch (error) {
        this.store.setFailure(feedbackId, "classification_failed", "The classifier did not return a valid result");
        this.store.transition(feedbackId, "classification_failed", { retryable: true });
        return;
      }
    }
    const current = this.store.getFeedback(feedbackId) as FeedbackRecord;
    const classification = current.classification;
    if (!classification) return;
    if (!current.issueNumber) {
      const project = [...this.store.projects.values()].find((item) => item.id === current.projectId);
      if (!project) throw new Error("Project not found");
      const issue = await this.git.createIssue({
        feedbackId,
        title: buildIssueTitle(classification.summary),
        body: buildIssueBody(current, classification, feedbackId),
        labels: ["feedback", `feedback:type:${classification.type}`, `feedback:priority:${classification.priority}`, classification.needsClarification || classification.confidence < 0.55 ? "feedback:status:needs-review" : "feedback:status:triaged"]
      });
      this.store.setIssue(feedbackId, issue.number, issue.url);
      this.store.transition(feedbackId, "issue_created", { issueNumber: issue.number });
      if (classification.needsClarification || classification.confidence < 0.55) {
        this.store.setFailure(feedbackId, "needs_clarification", classification.clarificationReason || "Insufficient context");
        this.store.transition(feedbackId, "needs_human_review", { reason: "classification_requires_review" });
        return;
      }
    }
    if (current.status === "issue_created") this.store.transition(feedbackId, "queued");
    if (current.status === "queued") this.store.transition(feedbackId, "agent_running");
    const run = this.store.createAgentRun(feedbackId);
    const project = [...this.store.projects.values()].find((item) => item.id === current.projectId);
    if (!project) throw new Error("Project not found");
    const workspace = mkdtempSync(join(tmpdir(), "feedback-code-"));
    try {
      cpSync(this.options.fixtureRoot, workspace, { recursive: true });
      const tools = new WorkspaceTools(workspace);
      tools.readFile("AGENTS.md");
      tools.readFile("package.json");
      tools.searchCode(current.selectedElement.feedbackId || current.selectedElement.testId || current.page.path);
      const branchName = `feedback/${feedbackId}-${slugify(classification.summary)}`;
      const baseSha = current.appRevision || "fixture-base-sha";
      await this.git.createBranch({ feedbackId, branchName, baseSha });
      run.branchName = branchName;
      run.baseSha = baseSha;
      const patch = this.buildDeterministicPatch(current);
      if (!patch) {
        this.store.setFailure(feedbackId, "not_reproducible", "No safe deterministic change matched the selected element and feedback");
        this.store.finishAgentRun(run.id, { status: "needs_human_review", summary: "No reproducible change was identified" });
        this.store.transition(feedbackId, "needs_human_review", { reason: "not_reproducible" });
        return;
      }
      tools.applyPatch(patch);
      this.store.transition(feedbackId, "validating");
      const results = [];
      for (const commandId of ["lint", "typecheck", "test", "build", "playwright"] as const) {
        results.push(await tools.runAllowedCommand(commandId));
      }
      const diff = tools.gitDiff();
      const report: ValidationReport = {
        generatedAt: new Date().toISOString(),
        results,
        changedFiles: diff.files,
        diffStat: diff.diffStat,
        visualCheck: "not_reproducible"
      };
      tools.writeReport(report);
      const finalDiff = tools.gitDiff();
      report.changedFiles = finalDiff.files;
      report.diffStat = finalDiff.diffStat;
      run.validationReport = report;
      const failed = results.some((result) => result.status === "failed" || result.status === "timed_out");
      if (failed) {
        this.store.setFailure(feedbackId, "validation_failed", "At least one configured validation failed");
      }
      const pullRequest = await this.git.createPullRequest({
        feedbackId,
        title: buildIssueTitle(classification.summary),
        body: this.buildPullRequestBody(current, report),
        branchName,
        baseBranch: project.githubBaseBranch,
        validationReport: report
      });
      this.store.setPullRequest(feedbackId, pullRequest);
      this.store.finishAgentRun(run.id, { status: "completed", summary: failed ? "PR opened with visible validation failures" : "PR opened with configured validations passed", validationReport: report });
      this.store.transition(feedbackId, "pr_opened", { pullRequestNumber: pullRequest.number, validationFailed: failed });
      await this.git.addComment({ issueNumber: current.issueNumber as number, body: `PR abierta: ${pullRequest.url}. El merge requiere revisión humana.` });
    } catch (error) {
      this.store.setFailure(feedbackId, "agent_failed", "Agent stopped before publishing a pull request");
      const activeRun = this.store.agentRuns.get(run.id);
      if (activeRun?.status === "running") this.store.finishAgentRun(run.id, { status: "failed", summary: error instanceof Error ? error.message : "Unknown agent error" });
      const latest = this.store.getFeedback(feedbackId);
      if (latest && ["agent_running", "validating"].includes(latest.status)) this.store.transition(feedbackId, "failed", { retryable: true });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  private buildDeterministicPatch(feedback: FeedbackRecord): string | undefined {
    const selected = feedback.selectedElement.feedbackId || feedback.selectedElement.testId;
    if (feedback.classification?.type !== "visual" || selected !== "checkout-submit") return undefined;
    return `*** Begin Patch\n*** Update File: src/checkout.css\n@@\n-.checkout-submit {\n-  white-space: nowrap;\n-  max-width: 120px;\n-  overflow: hidden;\n-}\n+.checkout-submit {\n+  white-space: nowrap;\n+  max-width: none;\n+  overflow: visible;\n+}\n*** End Patch`;
  }

  private buildPullRequestBody(feedback: FeedbackRecord, report: ValidationReport): string {
    const checks = report.results.map((result) => `- ${result.status === "passed" ? "[x]" : "[ ]"} ${result.commandId}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`).join("\n");
    return [
      "## Feedback resuelto",
      "",
      `Closes #${feedback.issueNumber}`,
      "",
      "## Qué cambió",
      "- Se ajustó el ancho efectivo del botón seleccionado para evitar el recorte del texto.",
      "",
      "## Validación",
      checks,
      "- [ ] visual check (not_reproducible en la demo local)",
      "",
      "## Evidencia",
      `- Reporte del agente: validation-report.json (${report.diffStat})`,
      "",
      "## Riesgos o limitaciones",
      "- El screenshot after requiere una receta Playwright configurada en el repositorio objetivo.",
      "- El merge queda en manos de una persona."
    ].join("\n");
  }
}
