import { resolve } from "node:path";
import { getConfig, githubPrivateKey } from "../../../packages/config/src/index.ts";
import { createDatabasePool, runMigrations } from "../../../packages/db/src/client.ts";
import { PostgresFeedbackStore } from "../../../packages/db/src/store.ts";
import { GitHubAppProvider, MockGitHubProvider } from "../../../packages/github/src/index.ts";
import { MockLLMProvider, OpenAIResponsesProvider } from "../../../packages/openai/src/index.ts";
import { createFeedbackWorker } from "../../../packages/queue/src/index.ts";
import { ProductionAgentWorker } from "../../../packages/agent/src/production-worker.ts";

const config = getConfig();
config.MOCK_TARGET_REPO = resolve(config.MOCK_TARGET_REPO);
const pool = createDatabasePool(config.DATABASE_URL);
if (config.AUTO_MIGRATE) await runMigrations(pool);
const store = new PostgresFeedbackStore(pool);

const llm = config.INTEGRATION_MODE === "real"
  ? new OpenAIResponsesProvider({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL, timeoutMs: config.OPENAI_TIMEOUT_MS, reasoningEffort: config.OPENAI_REASONING_EFFORT, maxAgentTurns: config.OPENAI_MAX_AGENT_TURNS })
  : new MockLLMProvider();

const git = config.INTEGRATION_MODE === "real"
  ? new GitHubAppProvider({ appId: config.GITHUB_APP_ID, privateKey: githubPrivateKey(config), installationId: config.GITHUB_INSTALLATION_ID as number, owner: config.GITHUB_OWNER, repo: config.GITHUB_REPO, apiVersion: config.GITHUB_API_VERSION })
  : new MockGitHubProvider();

const processor = new ProductionAgentWorker(store, llm, git, config);
const { worker, connection } = createFeedbackWorker(config.REDIS_URL, async (job) => {
  const feedbackId = typeof job.data?.feedbackId === "string" ? job.data.feedbackId : "";
  if (!feedbackId) throw new Error("Queue job is missing feedbackId");
  await processor.process(feedbackId);
  return { feedbackId, processedAt: new Date().toISOString() };
}, config.WORKER_MAX_CONCURRENCY);

worker.on("completed", (job) => console.info(JSON.stringify({ level: "info", event: "job.completed", jobId: job.id, feedbackId: job.data.feedbackId })));
worker.on("failed", (job, error) => console.error(JSON.stringify({ level: "error", event: "job.failed", jobId: job?.id, feedbackId: job?.data?.feedbackId, message: error.message.slice(0, 500) })));
worker.on("error", (error) => console.error(JSON.stringify({ level: "error", event: "worker.error", message: error.message.slice(0, 500) })));

console.info(JSON.stringify({ level: "info", event: "worker.started", mode: config.INTEGRATION_MODE, concurrency: config.WORKER_MAX_CONCURRENCY }));

const shutdown = async () => { await worker.close(); await connection.quit(); await pool.end(); process.exit(0); };
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
