import { Queue, Worker, JobsOptions, QueueScheduler } from "bullmq";
import IORedis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const redisHostEnv = process.env.REDIS_HOST;
const redisHost =
  redisHostEnv && redisHostEnv !== "redis" ? redisHostEnv : "localhost";
const redisPort = Number(process.env.REDIS_PORT ?? "6379");
const redisPassword = process.env.REDIS_PASSWORD || undefined;

export const redisConnection = new IORedis({
  host: redisHost,
  port: redisPort,
  password: redisPassword || undefined,
  // BullMQ требует maxRetriesPerRequest = null, иначе будет бросать ошибку.
  maxRetriesPerRequest: null,
});

export type QueueName =
  | "call_processing"
  | "history_sync"
  | "daily_reports"
  | "telegram_notifications"
  | "ai_coach";

export function createQueue(name: QueueName) {
  return new Queue(name, {
    connection: redisConnection,
    defaultJobOptions: defaultJobOptionsByQueue[name],
  });
}

export function createWorker(
  name: QueueName,
  processor: Parameters<typeof Worker>[1]
) {
  return new Worker(name, processor, {
    connection: redisConnection,
    concurrency: concurrencyByQueue[name],
  });
}

export function createScheduler(name: QueueName) {
  return new QueueScheduler(name, { connection: redisConnection });
}

const defaultJobOptionsByQueue: Record<QueueName, JobsOptions> = {
  call_processing: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 30_000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
  history_sync: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 60_000,
    },
    removeOnComplete: true,
    removeOnFail: 1000,
  },
  daily_reports: {
    attempts: 3,
    backoff: {
      type: "fixed",
      delay: 60_000,
    },
    removeOnComplete: true,
    removeOnFail: 1000,
  },
  telegram_notifications: {
    attempts: 5,
    backoff: {
      type: "fixed",
      delay: 30_000,
    },
    removeOnComplete: true,
    removeOnFail: 2000,
  },
  ai_coach: {
    attempts: 2,
    backoff: {
      type: "fixed",
      delay: 60_000,
    },
    removeOnComplete: true,
    removeOnFail: 500,
  },
};

const concurrencyByQueue: Record<QueueName, number> = {
  call_processing: 5, // ограничиваем одновременную обработку звонков
  history_sync: 1,
  daily_reports: 2,
  telegram_notifications: 5,
  ai_coach: 2,
};

