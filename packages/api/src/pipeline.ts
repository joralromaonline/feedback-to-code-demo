import { AgentWorker } from "../../agent/src/worker.ts";
import { MockGitHubProvider } from "../../github/src/index.ts";
import { MockLLMProvider } from "../../openai/src/index.ts";
import type { FeedbackInput } from "../../domain/src/index.ts";
import { parseFeedbackInput, ContractValidationError } from "../../contracts/src/index.ts";
import { newId } from "../../domain/src/index.ts";
import { InMemoryFeedbackStore } from "./store.ts";

export class InMemoryQueue {
  private jobs: string[] = [];
  private queued = new Set<string>();

  publish(feedbackId: string): boolean {
    if (this.queued.has(feedbackId)) return false;
    this.jobs.push(feedbackId);
    this.queued.add(feedbackId);
    return true;
  }

  take(): string | undefined {
    const feedbackId = this.jobs.shift();
    if (feedbackId) this.queued.delete(feedbackId);
    return feedbackId;
  }

  get size(): number { return this.jobs.length; }
}

export interface IngestResult {
  statusCode: 202 | 400 | 401;
  body: Record<string, unknown>;
}

export class FeedbackIngestService {
  private store: InMemoryFeedbackStore;
  private queue: InMemoryQueue;

  constructor(store: InMemoryFeedbackStore, queue: InMemoryQueue) {
    this.store = store;
    this.queue = queue;
  }

  ingest(rawBody: unknown, projectKey: string, idempotencyKey?: string, requestId = newId("req")): IngestResult {
    const project = this.store.findProjectByPublicKey(projectKey);
    if (!project) return { statusCode: 401, body: { error: "Invalid project key", requestId } };
    try {
      const input = parseFeedbackInput(rawBody, projectKey, idempotencyKey);
      const result = this.store.createFeedback(project, input);
      if (result.created) this.queue.publish(result.record.id);
      return { statusCode: 202, body: { feedbackId: result.record.id, status: "received", requestId } };
    } catch (error) {
      if (error instanceof ContractValidationError) return { statusCode: 400, body: { error: "Invalid feedback payload", issues: error.issues, requestId } };
      return { statusCode: 400, body: { error: "Invalid feedback payload", requestId } };
    }
  }
}

export function createDemoSystem(fixtureRoot: string) {
  const store = new InMemoryFeedbackStore();
  const queue = new InMemoryQueue();
  const project = store.registerProject({ publicKey: "pk_demo_public_key", name: "Checkout demo", githubOwner: "acme", githubRepo: "checkout", githubBaseBranch: "main" });
  const github = new MockGitHubProvider();
  const llm = new MockLLMProvider();
  const ingest = new FeedbackIngestService(store, queue);
  const worker = new AgentWorker(store, llm, github, { fixtureRoot, maxTurns: 10 });
  return {
    store,
    queue,
    project,
    github,
    llm,
    ingest,
    worker,
    async drain(): Promise<void> {
      let feedbackId = queue.take();
      while (feedbackId) {
        await worker.process(feedbackId);
        feedbackId = queue.take();
      }
    }
  };
}

export type DemoSystem = ReturnType<typeof createDemoSystem>;

export function fixtureFeedback(): FeedbackInput {
  return {
    clientFeedbackId: "00000000-0000-4000-8000-000000000001",
    projectKey: "pk_demo_public_key",
    comment: "El texto del botón queda cortado en 1280 px; debe permanecer en una línea",
    page: { url: "http://localhost:3000/checkout", path: "/checkout", title: "Checkout" },
    environment: "development",
    viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
    selectedElement: {
      tagName: "button",
      accessibleName: "Continuar al pago",
      attributes: { "data-feedback-id": "checkout-submit" },
      testId: "checkout-submit",
      feedbackId: "checkout-submit",
      boundingBox: { x: 100, y: 200, width: 120, height: 40 },
      ancestorSummary: [{ tagName: "form" }]
    },
    client: { sdkVersion: "0.1.0", userAgent: "fixture" },
    appRevision: "fixture-base-sha"
  };
}
