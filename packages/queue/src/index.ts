import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import { Redis } from "ioredis";

export const FEEDBACK_QUEUE = "feedback-code";

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}

export function createFeedbackQueue(redisUrl: string): { queue: Queue; connection: Redis } {
  const connection = createRedisConnection(redisUrl);
  const queue = new Queue(FEEDBACK_QUEUE, { connection });
  return { queue, connection };
}

export type EnqueueFeedbackResult = "enqueued" | "retried" | "already_queued" | "active";

export async function enqueueFeedback(queue: Queue, feedbackId: string): Promise<EnqueueFeedbackResult> {
  const jobId = `feedback-${feedbackId}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed") {
      await existing.remove();
    } else if (state === "completed") {
      await existing.remove();
    } else {
      return state === "active" ? "active" : "already_queued";
    }
  }
  const options: JobsOptions = {
    jobId,
    attempts: 2,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 604_800, count: 5_000 }
  };
  await queue.add("feedback.received", { feedbackId }, options);
  return existing ? "retried" : "enqueued";
}

export function createFeedbackWorker(redisUrl: string, processor: Processor, concurrency = 1): { worker: Worker; connection: Redis } {
  const connection = createRedisConnection(redisUrl);
  const worker = new Worker(FEEDBACK_QUEUE, processor, { connection, concurrency, lockDuration: 180_000 });
  return { worker, connection };
}
