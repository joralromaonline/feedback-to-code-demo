import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIssueBody, buildIssueTitle } from "../../contracts/src/index.ts";
import type { RuntimeConfig } from "../../config/src/index.ts";
import type { PostgresFeedbackStore } from "../../db/src/store.ts";
import type { GitProvider } from "../../github/src/index.ts";
import type { LLMProvider, OpenAIResponsesProvider } from "../../openai/src/index.ts";
import { slugify, type FeedbackRecord, type ValidationReport } from "../../domain/src/index.ts";
import { createAgentToolDefinitions } from "./tool-definitions.ts";
import { WorkspaceTools } from "./tools.ts";

interface ProcessResult { exitCode: number; output: string; durationMs: number; }

async function runProcess(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, shell: false, stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-30_000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs || 120_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveResult({ exitCode: code ?? 1, output, durationMs: Date.now() - started });
    });
    if (options.input) child.stdin?.end(options.input);
  });
}

function gitAuthenticationEnv(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0"
  };
}

function assertSafeDiff(diff: string): void {
  const forbidden = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /(?:OPENAI_API_KEY|GITHUB_PRIVATE_KEY|DATABASE_URL|S3_SECRET_KEY)\s*=\s*[^\s"']{8,}/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/
  ];
  if (forbidden.some((pattern) => pattern.test(diff))) throw new Error("Potential secret detected in generated diff");
}

function repositoryInstructions(workspace: string): string {
  const files = ["AGENTS.md", "CONTRIBUTING.md"];
  return files.filter((name) => existsSync(join(workspace, name))).map((name) => `# ${name}\n${readFileSync(join(workspace, name), "utf8").slice(0, 20_000)}`).join("\n\n");
}

export class ProductionAgentWorker {
  private store: PostgresFeedbackStore;
  private llm: LLMProvider;
  private git: GitProvider;
  private config: RuntimeConfig;

  constructor(store: PostgresFeedbackStore, llm: LLMProvider, git: GitProvider, config: RuntimeConfig) {
    this.store = store;
    this.llm = llm;
    this.git = git;
    this.config = config;
  }

  async process(feedbackId: string): Promise<void> {
    let feedback = await this.store.getFeedback(feedbackId);
    if (!feedback || feedback.status === "pr_opened" || feedback.status === "merged" || feedback.status === "closed" || feedback.status === "needs_human_review") return;

    if (!feedback.classification) {
      if (feedback.status === "received" || feedback.status === "classification_failed") await this.store.transition(feedbackId, "classifying");
      try {
        const classification = await this.llm.classify({ feedback, feedbackId });
        await this.store.setClassification(feedbackId, classification);
        await this.store.transition(feedbackId, "classified", { type: classification.type, confidence: classification.confidence });
      } catch {
        await this.store.setFailure(feedbackId, "classification_failed", "The classifier did not return a valid structured result");
        const current = await this.store.getFeedback(feedbackId);
        if (current?.status === "classifying") await this.store.transition(feedbackId, "classification_failed", { retryable: true });
        throw new Error("Classification failed");
      }
    }

    feedback = (await this.store.getFeedback(feedbackId)) as FeedbackRecord;
    const classification = feedback.classification;
    const project = await this.store.getProject(feedback.projectId);
    if (!classification || !project) throw new Error("Feedback classification or project is missing");

    if (!feedback.issueNumber) {
      const attachments = await this.store.listAttachments(feedbackId);
      const attachmentSection = attachments.length ? `\n\n## Evidencia\n\n${attachments.map((attachment) => `- Screenshot: ${this.config.PUBLIC_API_ORIGIN}/v1/attachments/${attachment.id}`).join("\n")}` : "";
      const issue = await this.git.createIssue({
        feedbackId,
        owner: project.githubOwner,
        repo: project.githubRepo,
        installationId: project.githubInstallationId,
        title: buildIssueTitle(classification.summary),
        body: `${buildIssueBody(feedback, classification, feedbackId)}${attachmentSection}`,
        labels: ["feedback", `feedback:type:${classification.type}`, `feedback:priority:${classification.priority}`, classification.needsClarification || classification.confidence < 0.55 ? "feedback:status:needs-review" : "feedback:status:triaged"]
      });
      await this.store.setIssue(feedbackId, issue.number, issue.url);
      await this.store.transition(feedbackId, "issue_created", { issueNumber: issue.number });
      feedback = (await this.store.getFeedback(feedbackId)) as FeedbackRecord;
    }

    if (feedback.issueNumber && feedback.status === "classified") {
      await this.store.transition(feedbackId, "issue_created", { issueNumber: feedback.issueNumber, resumed: true });
      feedback = (await this.store.getFeedback(feedbackId)) as FeedbackRecord;
    }

    if (classification.needsClarification || classification.confidence < 0.55) {
      await this.store.setFailure(feedbackId, "needs_clarification", classification.clarificationReason || "Insufficient context");
      if (feedback.status === "issue_created") await this.store.transition(feedbackId, "needs_human_review", { reason: "classification_requires_review" });
      if (this.git.updateIssueStatus && project.githubInstallationId) await this.git.updateIssueStatus({ issueNumber: feedback.issueNumber as number, owner: project.githubOwner, repo: project.githubRepo, installationId: project.githubInstallationId, status: "needs-review" });
      return;
    }

    if (["failed", "blocked"].includes(feedback.status)) await this.store.transition(feedbackId, "queued", { retry: true });
    else if (feedback.status === "issue_created") await this.store.transition(feedbackId, "queued");
    feedback = (await this.store.getFeedback(feedbackId)) as FeedbackRecord;
    if (feedback.status === "queued") await this.store.transition(feedbackId, "agent_running");

    const run = await this.store.createAgentRun(feedbackId, project.id, this.config.INTEGRATION_MODE === "real" ? this.config.OPENAI_MODEL : "mock");
    const branchName = `feedback/${feedbackId}-${slugify(classification.summary)}`;
    const workspaceParent = resolve(this.config.WORKSPACE_ROOT);
    mkdirSync(workspaceParent, { recursive: true });
    const workspace = mkdtempSync(join(workspaceParent, `${feedbackId}-`));
    let gitEnv = process.env;

    try {
      if (this.config.INTEGRATION_MODE === "real") {
        if (!project.githubInstallationId || !this.git.getInstallationToken) throw new Error("GitHub installation credentials are unavailable");
        const token = await this.git.getInstallationToken(project.githubInstallationId);
        gitEnv = gitAuthenticationEnv(token);
        const clone = await runProcess("git", ["clone", "--filter=blob:none", "--no-checkout", `https://github.com/${project.githubOwner}/${project.githubRepo}.git`, workspace], { cwd: workspaceParent, env: gitEnv, timeoutMs: this.config.COMMAND_TIMEOUT_MS });
        if (clone.exitCode !== 0) throw new Error(`Git clone failed: ${clone.output.slice(-2_000)}`);
        const target = feedback.appRevision && /^[a-f0-9]{7,40}$/i.test(feedback.appRevision) ? feedback.appRevision : `origin/${project.githubBaseBranch}`;
        const checkout = await runProcess("git", ["checkout", "-b", branchName, target], { cwd: workspace, env: gitEnv, timeoutMs: this.config.COMMAND_TIMEOUT_MS });
        if (checkout.exitCode !== 0) throw new Error(`Git checkout failed: ${checkout.output.slice(-2_000)}`);
      } else {
        const fixture = resolve(this.config.MOCK_TARGET_REPO);
        cpSync(fixture, workspace, { recursive: true });
        await runProcess("git", ["init", "-b", project.githubBaseBranch], { cwd: workspace });
        await runProcess("git", ["config", "user.name", "Feedback-to-Code"], { cwd: workspace });
        await runProcess("git", ["config", "user.email", "feedback-code@example.invalid"], { cwd: workspace });
        await runProcess("git", ["add", "."], { cwd: workspace });
        await runProcess("git", ["commit", "-m", "fixture baseline"], { cwd: workspace });
        await runProcess("git", ["checkout", "-b", branchName], { cwd: workspace });
      }

      const baseShaResult = await runProcess("git", ["rev-parse", "HEAD"], { cwd: workspace, env: gitEnv });
      const baseSha = baseShaResult.output.trim() || feedback.appRevision || "unknown";
      await this.store.updateAgentRun(run.id, { branchName, baseSha });
      const tools = new WorkspaceTools(workspace);

      if (this.config.INTEGRATION_MODE === "mock") {
        const selected = feedback.selectedElement.feedbackId || feedback.selectedElement.testId;
        if (classification.type !== "visual" || selected !== "checkout-submit") {
          await this.store.setFailure(feedbackId, "not_reproducible", "Mock scenario only supports the checkout-submit visual overflow fixture");
          await this.store.finishAgentRun(run.id, { status: "needs_human_review", summary: "No deterministic fixture change matched", blockedReason: "not_reproducible" });
          await this.store.transition(feedbackId, "needs_human_review", { reason: "not_reproducible" });
          return;
        }
        tools.applyPatch(`*** Begin Patch\n*** Update File: src/checkout.css\n@@\n-.checkout-submit {\n-  white-space: nowrap;\n-  max-width: 120px;\n-  overflow: hidden;\n-}\n+.checkout-submit {\n+  white-space: nowrap;\n+  max-width: none;\n+  overflow: visible;\n+}\n*** End Patch`);
      } else {
        const provider = this.llm as OpenAIResponsesProvider;
        if (typeof provider.runAgent !== "function") throw new Error("Configured LLM provider does not support code-agent execution");
        const agentResult = await provider.runAgent({
          feedbackId,
          issueNumber: feedback.issueNumber as number,
          feedback,
          classification,
          repositoryInstructions: repositoryInstructions(workspace),
          maxTurns: this.config.OPENAI_MAX_AGENT_TURNS
        }, createAgentToolDefinitions(tools));
        if (agentResult.status !== "completed") {
          await this.store.setFailure(feedbackId, agentResult.reason || "agent_requires_review", agentResult.summary);
          await this.store.finishAgentRun(run.id, { status: agentResult.status, summary: agentResult.summary, blockedReason: agentResult.reason });
          await this.store.transition(feedbackId, agentResult.status === "failed" ? "failed" : "needs_human_review", { reason: agentResult.reason || "agent_stopped" });
          return;
        }
      }

      await this.store.transition(feedbackId, "validating");
      const results = [];
      for (const commandId of ["lint", "typecheck", "test", "build", "playwright"] as const) results.push(await tools.runAllowedCommand(commandId, this.config.COMMAND_TIMEOUT_MS));
      const beforeReport = tools.gitDiff();
      if (!beforeReport.files.length) {
        await this.store.setFailure(feedbackId, "empty_diff", "Agent completed without a code diff");
        await this.store.finishAgentRun(run.id, { status: "needs_human_review", summary: "No code changes were produced", blockedReason: "empty_diff" });
        await this.store.transition(feedbackId, "needs_human_review", { reason: "empty_diff" });
        return;
      }
      assertSafeDiff(beforeReport.diff);
      const report: ValidationReport = {
        generatedAt: new Date().toISOString(), results, changedFiles: beforeReport.files, diffStat: beforeReport.diffStat,
        visualCheck: results.find((result) => result.commandId === "playwright")?.status === "passed" ? "pass" : "not_reproducible"
      };
      tools.writeReport(report);
      const finalDiff = tools.gitDiff();
      assertSafeDiff(finalDiff.diff);
      report.changedFiles = finalDiff.files;
      report.diffStat = finalDiff.diffStat;

      const add = await runProcess("git", ["add", "--", ...finalDiff.files], { cwd: workspace, env: gitEnv, timeoutMs: this.config.COMMAND_TIMEOUT_MS });
      if (add.exitCode !== 0) throw new Error(`Git add failed: ${add.output.slice(-2_000)}`);
      const commit = await runProcess("git", ["-c", "user.name=Feedback-to-Code", "-c", "user.email=feedback-code@example.invalid", "commit", "-m", `fix: ${classification.summary.slice(0, 72)}`], { cwd: workspace, env: gitEnv, timeoutMs: this.config.COMMAND_TIMEOUT_MS });
      if (commit.exitCode !== 0) throw new Error(`Git commit failed: ${commit.output.slice(-2_000)}`);
      const head = await runProcess("git", ["rev-parse", "HEAD"], { cwd: workspace, env: gitEnv });

      if (this.config.INTEGRATION_MODE === "real") {
        if (branchName === project.githubBaseBranch || !branchName.startsWith("feedback/")) throw new Error("Refusing to push unsafe branch");
        const push = await runProcess("git", ["push", "origin", `HEAD:refs/heads/${branchName}`], { cwd: workspace, env: gitEnv, timeoutMs: this.config.COMMAND_TIMEOUT_MS });
        if (push.exitCode !== 0) throw new Error(`Git push failed: ${push.output.slice(-2_000)}`);
      } else {
        await this.git.createBranch({ feedbackId, branchName, baseSha });
      }

      const validationLines = report.results.map((result) => `- ${result.status === "passed" ? "[x]" : "[ ]"} ${result.commandId}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`).join("\n");
      const pullRequest = await this.git.createPullRequest({
        feedbackId, owner: project.githubOwner, repo: project.githubRepo, installationId: project.githubInstallationId,
        title: buildIssueTitle(classification.summary), branchName, baseBranch: project.githubBaseBranch, validationReport: report,
        body: `## Feedback resuelto\n\nCloses #${feedback.issueNumber}\n\n## Qué cambió\n- ${classification.summary}\n\n## Validación\n${validationLines}\n\n## Evidencia\n- validation-report.json\n- Diff: ${report.diffStat}\n\n## Riesgos o limitaciones\n- El merge requiere revisión humana.\n- Visual check: ${report.visualCheck}`
      });
      pullRequest.headSha = head.output.trim() || pullRequest.headSha;
      await this.store.setPullRequest(feedbackId, project.id, run.id, pullRequest);
      await this.store.finishAgentRun(run.id, { status: "completed", summary: "Pull request opened; human review required", validationReport: report });
      await this.store.transition(feedbackId, "pr_opened", { pullRequestNumber: pullRequest.number });
      await this.git.addComment({ issueNumber: feedback.issueNumber as number, body: `PR abierta: ${pullRequest.url}. El merge requiere revisión humana.` });
      if (this.git.updateIssueStatus && project.githubInstallationId) await this.git.updateIssueStatus({ issueNumber: feedback.issueNumber as number, owner: project.githubOwner, repo: project.githubRepo, installationId: project.githubInstallationId, status: "pr-opened" });
    } catch (error) {
      const safeMessage = error instanceof Error ? error.message.replace(/(?:gh[pousr]_[A-Za-z0-9_]+|Bearer\s+\S+)/g, "[REDACTED]").slice(0, 500) : "Unknown worker error";
      await this.store.setFailure(feedbackId, "agent_failed", safeMessage);
      await this.store.finishAgentRun(run.id, { status: "failed", summary: safeMessage });
      const current = await this.store.getFeedback(feedbackId);
      if (current && ["agent_running", "validating"].includes(current.status)) await this.store.transition(feedbackId, "failed", { retryable: true });
      throw error;
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}
