import type { BranchRef, IssueRef, PullRequestRef, ValidationReport } from "../../domain/src/index.ts";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";

export interface IssueInput {
  feedbackId: string;
  title: string;
  body: string;
  labels: string[];
  owner?: string;
  repo?: string;
  installationId?: number;
}

export interface PullRequestInput {
  feedbackId: string;
  title: string;
  body: string;
  branchName: string;
  baseBranch: string;
  validationReport: ValidationReport;
  owner?: string;
  repo?: string;
  installationId?: number;
}

export interface GitProvider {
  createIssue(input: IssueInput): Promise<IssueRef>;
  createBranch(input: { feedbackId: string; branchName: string; baseSha: string }): Promise<BranchRef>;
  createPullRequest(input: PullRequestInput): Promise<PullRequestRef>;
  addComment(input: { issueNumber: number; body: string }): Promise<void>;
  updateIssueStatus?(input: { issueNumber: number; owner: string; repo: string; installationId: number; status: "agent-running" | "pr-opened" | "needs-review" | "blocked" }): Promise<void>;
  getInstallationToken?(installationId: number): Promise<string>;
}

export class MockGitHubProvider implements GitProvider {
  private nextIssueNumber = 1;
  private nextPullRequestNumber = 1;
  readonly issues = new Map<string, IssueRef & { title: string; body: string; labels: string[]; comments: string[] }>();
  readonly branches = new Map<string, BranchRef>();
  readonly pullRequests = new Map<string, PullRequestRef>();

  async createIssue(input: IssueInput): Promise<IssueRef> {
    const existing = this.issues.get(input.feedbackId);
    if (existing) return { number: existing.number, url: existing.url };
    const issue = {
      number: this.nextIssueNumber++,
      url: `https://github.example.test/acme/checkout/issues/${this.nextIssueNumber - 1}`,
      title: input.title,
      body: input.body,
      labels: [...new Set(input.labels)],
      comments: []
    };
    this.issues.set(input.feedbackId, issue);
    return { number: issue.number, url: issue.url };
  }

  async createBranch(input: { feedbackId: string; branchName: string; baseSha: string }): Promise<BranchRef> {
    const existing = this.branches.get(input.feedbackId);
    if (existing) return existing;
    if (!input.branchName.startsWith("feedback/")) throw new Error("Branches must use feedback/ prefix");
    if (input.branchName.endsWith("main")) throw new Error("Cannot create a base branch as agent branch");
    const branch = { name: input.branchName, baseSha: input.baseSha };
    this.branches.set(input.feedbackId, branch);
    return branch;
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequestRef> {
    const existing = this.pullRequests.get(input.feedbackId);
    if (existing) return existing;
    if (input.baseBranch === input.branchName || input.baseBranch === "") throw new Error("PR base branch is invalid");
    const number = this.nextPullRequestNumber++;
    const pullRequest: PullRequestRef = {
      number,
      url: `https://github.example.test/acme/checkout/pull/${number}`,
      branchName: input.branchName,
      headSha: `mock-sha-${input.feedbackId.slice(-8)}`,
      validationSummary: input.validationReport
    };
    this.pullRequests.set(input.feedbackId, pullRequest);
    return pullRequest;
  }

  async addComment(input: { issueNumber: number; body: string }): Promise<void> {
    for (const issue of this.issues.values()) {
      if (issue.number === input.issueNumber) issue.comments.push(input.body);
    }
  }
}

const LABELS: Record<string, { color: string; description: string }> = {
  feedback: { color: "5319e7", description: "Feedback captured by Feedback-to-Code" },
  "feedback:type:bug": { color: "d73a4a", description: "Functional bug" },
  "feedback:type:visual": { color: "1d76db", description: "Visual issue" },
  "feedback:type:content": { color: "0075ca", description: "Content change" },
  "feedback:type:accessibility": { color: "7057ff", description: "Accessibility issue" },
  "feedback:type:performance": { color: "fbca04", description: "Performance issue" },
  "feedback:type:feature": { color: "a2eeef", description: "Feature request" },
  "feedback:type:unknown": { color: "cfd3d7", description: "Unclassified feedback" },
  "feedback:priority:low": { color: "c2e0c6", description: "Low priority" },
  "feedback:priority:medium": { color: "fbca04", description: "Medium priority" },
  "feedback:priority:high": { color: "f9d0c4", description: "High priority" },
  "feedback:priority:critical": { color: "b60205", description: "Critical priority" },
  "feedback:status:triaged": { color: "0e8a16", description: "Feedback triaged" },
  "feedback:status:agent-running": { color: "1d76db", description: "Agent is running" },
  "feedback:status:pr-opened": { color: "5319e7", description: "Pull request opened" },
  "feedback:status:needs-review": { color: "d4c5f9", description: "Human review required" },
  "feedback:status:blocked": { color: "b60205", description: "Automation blocked" }
};

export class GitHubAppProvider implements GitProvider {
  private app: App<{ Octokit: typeof Octokit }>;
  private apiVersion: string;
  private defaultOwner: string;
  private defaultRepo: string;
  private defaultInstallationId: number;

  constructor(options: { appId: string; privateKey: string; installationId: number; owner: string; repo: string; apiVersion?: string }) {
    this.app = new App({ appId: options.appId, privateKey: options.privateKey, Octokit });
    this.apiVersion = options.apiVersion || "2026-03-10";
    this.defaultOwner = options.owner;
    this.defaultRepo = options.repo;
    this.defaultInstallationId = options.installationId;
  }

  private target(input: { owner?: string; repo?: string; installationId?: number }) {
    return { owner: input.owner || this.defaultOwner, repo: input.repo || this.defaultRepo, installationId: input.installationId || this.defaultInstallationId };
  }

  private async octokit(installationId: number) {
    return this.app.getInstallationOctokit(installationId);
  }

  private async ensureLabels(owner: string, repo: string, installationId: number, names: string[]): Promise<void> {
    const octokit = await this.octokit(installationId);
    for (const name of names) {
      const definition = LABELS[name] || { color: "cfd3d7", description: "Feedback-to-Code label" };
      try {
        await octokit.rest.issues.getLabel({ owner, repo, name, headers: { "X-GitHub-Api-Version": this.apiVersion } });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404) throw error;
        await octokit.rest.issues.createLabel({ owner, repo, name, color: definition.color, description: definition.description, headers: { "X-GitHub-Api-Version": this.apiVersion } });
      }
    }
  }

  async createIssue(input: IssueInput): Promise<IssueRef> {
    const { owner, repo, installationId } = this.target(input);
    const octokit = await this.octokit(installationId);
    const marker = `Feedback interno: \`${input.feedbackId}\``;
    const existing = await octokit.rest.issues.listForRepo({ owner, repo, state: "all", labels: "feedback", per_page: 100, headers: { "X-GitHub-Api-Version": this.apiVersion } });
    const match = existing.data.find((issue) => !issue.pull_request && issue.body?.includes(marker));
    if (match) return { number: match.number, url: match.html_url };
    await this.ensureLabels(owner, repo, installationId, input.labels);
    const created = await octokit.rest.issues.create({ owner, repo, title: input.title, body: input.body, labels: input.labels, headers: { "X-GitHub-Api-Version": this.apiVersion } });
    return { number: created.data.number, url: created.data.html_url };
  }

  async createBranch(input: { feedbackId: string; branchName: string; baseSha: string; owner?: string; repo?: string; installationId?: number }): Promise<BranchRef> {
    if (!input.branchName.startsWith("feedback/") || input.branchName === "main") throw new Error("Unsafe branch name");
    const { owner, repo, installationId } = this.target(input);
    const octokit = await this.octokit(installationId);
    try {
      await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${input.branchName}`, sha: input.baseSha, headers: { "X-GitHub-Api-Version": this.apiVersion } });
    } catch (error) {
      if ((error as { status?: number }).status !== 422) throw error;
    }
    return { name: input.branchName, baseSha: input.baseSha };
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequestRef> {
    if (!input.branchName.startsWith("feedback/") || input.branchName === input.baseBranch) throw new Error("Unsafe pull request branch");
    const { owner, repo, installationId } = this.target(input);
    const octokit = await this.octokit(installationId);
    const existing = await octokit.rest.pulls.list({ owner, repo, state: "all", head: `${owner}:${input.branchName}`, base: input.baseBranch, per_page: 10, headers: { "X-GitHub-Api-Version": this.apiVersion } });
    const match = existing.data[0];
    if (match) return { number: match.number, url: match.html_url, branchName: input.branchName, headSha: match.head.sha, validationSummary: input.validationReport };
    const created = await octokit.rest.pulls.create({ owner, repo, title: input.title, body: input.body, head: input.branchName, base: input.baseBranch, draft: false, headers: { "X-GitHub-Api-Version": this.apiVersion } });
    return { number: created.data.number, url: created.data.html_url, branchName: input.branchName, headSha: created.data.head.sha, validationSummary: input.validationReport };
  }

  async addComment(input: { issueNumber: number; body: string; owner?: string; repo?: string; installationId?: number }): Promise<void> {
    const { owner, repo, installationId } = this.target(input);
    const octokit = await this.octokit(installationId);
    await octokit.rest.issues.createComment({ owner, repo, issue_number: input.issueNumber, body: input.body, headers: { "X-GitHub-Api-Version": this.apiVersion } });
  }

  async updateIssueStatus(input: { issueNumber: number; owner: string; repo: string; installationId: number; status: "agent-running" | "pr-opened" | "needs-review" | "blocked" }): Promise<void> {
    const statusLabel = `feedback:status:${input.status}`;
    await this.ensureLabels(input.owner, input.repo, input.installationId, [statusLabel]);
    const octokit = await this.octokit(input.installationId);
    const issue = await octokit.rest.issues.get({ owner: input.owner, repo: input.repo, issue_number: input.issueNumber, headers: { "X-GitHub-Api-Version": this.apiVersion } });
    const labels = issue.data.labels.map((label) => typeof label === "string" ? label : label.name || "").filter((name) => name && !name.startsWith("feedback:status:"));
    await octokit.rest.issues.setLabels({ owner: input.owner, repo: input.repo, issue_number: input.issueNumber, labels: [...labels, statusLabel], headers: { "X-GitHub-Api-Version": this.apiVersion } });
  }

  async getInstallationToken(installationId: number): Promise<string> {
    const authentication = await this.app.octokit.auth({ type: "installation", installationId }) as { token: string };
    return authentication.token;
  }
}
