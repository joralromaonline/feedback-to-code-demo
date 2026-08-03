import { newId, type FeedbackInput, type FeedbackStatus } from "../../domain/src/index.ts";
import { ContractValidationError, FeedbackPayloadSchema, parseScreenshot } from "../../contracts/src/index.ts";
import { getConfig, type RuntimeConfig } from "../../config/src/index.ts";
import { createDatabasePool, runMigrations } from "../../db/src/client.ts";
import { PostgresFeedbackStore } from "../../db/src/store.ts";
import { createFeedbackQueue, enqueueFeedback } from "../../queue/src/index.ts";
import { S3StorageProvider } from "../../storage/src/index.ts";
import { verifyGitHubWebhook } from "../../github/src/webhook.ts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import rawBody from "fastify-raw-body";

interface ScreenshotCandidate { bytes: Buffer; declaredMime?: string; }

function internalAuthorized(request: FastifyRequest, config: RuntimeConfig): boolean {
  const header = request.headers.authorization;
  return header === `Bearer ${config.INTERNAL_SERVICE_TOKEN}`;
}

async function parseIngestRequest(request: FastifyRequest): Promise<{ payload: unknown; screenshot?: ScreenshotCandidate }> {
  if (!request.isMultipart()) return { payload: request.body };
  let payload: unknown;
  let screenshot: ScreenshotCandidate | undefined;
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "screenshot") {
        part.file.resume();
        continue;
      }
      const bytes = await part.toBuffer();
      screenshot = { bytes, declaredMime: part.mimetype };
    } else if (part.fieldname === "payload") {
      payload = JSON.parse(String(part.value));
    }
  }
  return { payload, screenshot };
}

export async function buildProductionApi(config: RuntimeConfig = getConfig()): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.x-feedback-project-key", "req.headers.x-hub-signature-256"] }, bodyLimit: 6 * 1024 * 1024, genReqId: () => newId("req") });
  const pool = createDatabasePool(config.DATABASE_URL);
  const store = new PostgresFeedbackStore(pool);
  const storage = new S3StorageProvider({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, bucket: config.S3_BUCKET, accessKey: config.S3_ACCESS_KEY, secretKey: config.S3_SECRET_KEY, forcePathStyle: config.S3_FORCE_PATH_STYLE, serverSideEncryption: config.S3_SERVER_SIDE_ENCRYPTION });
  const { queue, connection } = createFeedbackQueue(config.REDIS_URL);

  if (config.AUTO_MIGRATE) await runMigrations(pool);
  await storage.ensureBucket();
  await store.seedProject({
    id: "proj_demo", publicKey: config.PUBLIC_DEMO_PROJECT_KEY, name: "Feedback-to-Code demo",
    githubInstallationId: config.GITHUB_INSTALLATION_ID, githubOwner: config.GITHUB_OWNER || "demo", githubRepo: config.GITHUB_REPO || "checkout-demo", githubBaseBranch: config.GITHUB_BASE_BRANCH
  });

  await app.register(cors, { origin: config.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean), methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["content-type", "x-feedback-project-key", "idempotency-key", "authorization"] });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 }, throwFileSizeLimit: false });
  await app.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });

  app.addHook("onSend", async (request, reply) => { reply.header("x-request-id", request.id); });

  app.get("/", async (request) => ({ service: "feedback-to-code", version: "0.1.0", requestId: request.id }));
  app.get("/healthz", async (request) => ({ ok: true, requestId: request.id }));

  app.post("/v1/feedback", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const projectKey = String(request.headers["x-feedback-project-key"] || "");
    const idempotencyKey = String(request.headers["idempotency-key"] || "");
    const project = await store.findProjectByPublicKey(projectKey);
    if (!project) return reply.code(401).send({ error: "Invalid project key", requestId: request.id });
    let parsedRequest: { payload: unknown; screenshot?: ScreenshotCandidate };
    try { parsedRequest = await parseIngestRequest(request); }
    catch { return reply.code(400).send({ error: "Invalid multipart payload", requestId: request.id }); }
    const schemaResult = FeedbackPayloadSchema.safeParse(parsedRequest.payload);
    if (!schemaResult.success) {
      const issues = schemaResult.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      request.log.warn({ event: "feedback.validation_failed", issues }, "Feedback payload validation failed");
      return reply.code(400).send({ error: "Invalid feedback payload", issues, requestId: request.id });
    }
    if (!idempotencyKey || idempotencyKey !== schemaResult.data.clientFeedbackId) return reply.code(400).send({ error: "Idempotency-Key must match clientFeedbackId", requestId: request.id });
    const bodyScreenshot = schemaResult.data.screenshot ? { bytes: Buffer.from(schemaResult.data.screenshot.base64, "base64"), declaredMime: schemaResult.data.screenshot.mimeType } : undefined;
    const input: FeedbackInput = { ...schemaResult.data, projectKey, screenshot: undefined };
    const created = await store.createFeedback(project, input);
    if (created.created) {
      const screenshot = parsedRequest.screenshot || bodyScreenshot;
      if (screenshot) {
        const attachmentId = newId("att");
        try {
          const valid = parseScreenshot(screenshot);
          const uploaded = await storage.putScreenshot({ projectId: project.id, feedbackId: created.record.id, bytes: valid.bytes, mimeType: valid.mimeType });
          await store.createAttachment({ id: attachmentId, projectId: project.id, feedbackId: created.record.id, storageKey: uploaded.key, mimeType: valid.mimeType, byteSize: valid.bytes.byteLength, sha256: valid.sha256, status: "stored" });
        } catch (error) {
          const message = error instanceof ContractValidationError ? error.issues.join("; ") : "Screenshot storage failed";
          await store.createAttachment({ id: attachmentId, projectId: project.id, feedbackId: created.record.id, status: "failed" });
          await store.appendEvent(created.record.id, "attachment.failed", { attachmentId, message: message.slice(0, 300) });
        }
      }
      await enqueueFeedback(queue, created.record.id);
    }
    return reply.code(202).send({ feedbackId: created.record.id, status: "received", requestId: request.id });
  });

  app.get<{ Params: { id: string } }>("/v1/feedback/:id", async (request, reply) => {
    const view = await store.publicView(request.params.id);
    return view ? reply.send({ ...view, requestId: request.id }) : reply.code(404).send({ error: "Feedback not found", requestId: request.id });
  });

  app.get<{ Params: { id: string } }>("/v1/attachments/:id", async (request, reply) => {
    const attachment = await store.getAttachment(request.params.id);
    if (!attachment?.storageKey || attachment.status !== "stored") return reply.code(404).send({ error: "Attachment not found", requestId: request.id });
    const object = await storage.getObject(attachment.storageKey);
    return reply.type(object.contentType || attachment.mimeType || "application/octet-stream").header("cache-control", "private, max-age=300").send(Buffer.from(object.bytes));
  });

  app.post("/v1/webhooks/github", { config: { rawBody: true } }, async (request, reply) => {
    const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    const deliveryId = request.headers["x-github-delivery"] as string | undefined;
    const eventName = String(request.headers["x-github-event"] || "");
    if (!raw || !deliveryId || !verifyGitHubWebhook(config.GITHUB_WEBHOOK_SECRET, raw, signature)) return reply.code(401).send({ error: "Invalid webhook signature", requestId: request.id });
    const payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    const action = typeof payload.action === "string" ? payload.action : undefined;
    const fresh = await store.registerWebhookDelivery(deliveryId, eventName, action);
    if (!fresh) return reply.code(202).send({ accepted: true, duplicate: true, requestId: request.id });
    if (eventName === "pull_request") {
      const repository = payload.repository as { name?: string; owner?: { login?: string } } | undefined;
      const pullRequest = payload.pull_request as { number?: number; merged?: boolean } | undefined;
      if (repository?.name && repository.owner?.login && pullRequest?.number && (action === "opened" || action === "closed" || action === "reopened")) {
        const status = action === "closed" ? pullRequest.merged ? "merged" : "closed" : "open";
        await store.updatePullRequestFromWebhook({ owner: repository.owner.login, repo: repository.name, number: pullRequest.number, status });
      }
    }
    return reply.code(202).send({ accepted: true, requestId: request.id });
  });

  app.get("/internal/health", async (request, reply) => {
    if (!internalAuthorized(request, config)) return reply.code(401).send({ error: "Unauthorized", requestId: request.id });
    const [database, objectStorage, redis] = await Promise.all([store.health(), storage.health(), connection.ping().then(() => true).catch(() => false)]);
    const ok = database && objectStorage && redis;
    return reply.code(ok ? 200 : 503).send({ ok, dependencies: { database, objectStorage, redis }, requestId: request.id });
  });

  app.get<{ Params: { id: string } }>("/internal/jobs/:id", async (request, reply) => {
    if (!internalAuthorized(request, config)) return reply.code(401).send({ error: "Unauthorized", requestId: request.id });
    const view = await store.operationalView(request.params.id);
    return view ? reply.send({ ...view, requestId: request.id }) : reply.code(404).send({ error: "Feedback not found", requestId: request.id });
  });

  app.get("/internal/metrics", async (request, reply) => {
    if (!internalAuthorized(request, config)) return reply.code(401).send({ error: "Unauthorized", requestId: request.id });
    return reply.send({ ...(await store.metrics()), requestId: request.id });
  });

  app.delete<{ Params: { id: string } }>("/internal/feedback/:id", async (request, reply) => {
    if (!internalAuthorized(request, config)) return reply.code(401).send({ error: "Unauthorized", requestId: request.id });
    const attachments = await store.listAttachments(request.params.id);
    if (!attachments.length && !await store.getFeedback(request.params.id)) return reply.code(404).send({ error: "Feedback not found", requestId: request.id });
    for (const attachment of attachments) if (attachment.storageKey) await storage.deleteObject(attachment.storageKey);
    const result = await store.deleteFeedback(request.params.id);
    return reply.send({ deleted: result.deleted, feedbackId: request.params.id, requestId: request.id });
  });

  app.post<{ Params: { id: string } }>("/internal/feedback/:id/retry", async (request, reply) => {
    if (!internalAuthorized(request, config)) return reply.code(401).send({ error: "Unauthorized", requestId: request.id });
    const feedback = await store.getFeedback(request.params.id);
    if (!feedback) return reply.code(404).send({ error: "Feedback not found", requestId: request.id });
    if (!["failed", "blocked", "classification_failed"].includes(feedback.status)) return reply.code(409).send({ error: "Feedback is not retryable in its current state", requestId: request.id });
    const existingJob = await queue.getJob(`feedback-${feedback.id}`);
    if (existingJob && await existingJob.getState() === "active") {
      return reply.code(409).send({ error: "The previous attempt is still stopping; retry after it finishes", requestId: request.id });
    }
    await store.clearFailure(feedback.id);
    await enqueueFeedback(queue, feedback.id);
    return reply.code(202).send({ accepted: true, feedbackId: feedback.id, requestId: request.id });
  });

  app.post<{ Params: { id: string } }>("/internal/feedback/:id/cancel", async (request, reply) => {
    if (!internalAuthorized(request, config)) return reply.code(401).send({ error: "Unauthorized", requestId: request.id });
    const feedback = await store.getFeedback(request.params.id);
    if (!feedback) return reply.code(404).send({ error: "Feedback not found", requestId: request.id });
    const cancelTargets: Partial<Record<FeedbackStatus, FeedbackStatus>> = {
      received: "failed",
      classifying: "classification_failed",
      classified: "failed",
      issue_created: "failed",
      queued: "failed",
      agent_running: "blocked",
      validating: "blocked"
    };
    const target = cancelTargets[feedback.status];
    if (!target) return reply.code(409).send({ error: "Feedback cannot be cancelled in its current state", requestId: request.id });
    await store.setFailure(feedback.id, "cancelled", "Cancelled by an internal operator");
    await store.transition(feedback.id, target, { reason: "cancelled" });
    return reply.send({ cancelled: true, feedbackId: feedback.id, requestId: request.id });
  });

  app.addHook("onClose", async () => { await queue.close(); await connection.quit(); await pool.end(); });
  return app;
}
