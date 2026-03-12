import { Queue, Worker, JobsOptions, Processor } from "bullmq";
import IORedis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const redisHostEnv = process.env.REDIS_HOST;
const redisHost =
  redisHostEnv && redisHostEnv !== "redis" ? redisHostEnv : "localhost";
const redisPort = Number(process.env.REDIS_PORT ?? "6379");
const redisPassword = process.env.REDIS_PASSWORD || undefined;

// Используется для прямых Redis операций (не BullMQ)
export const redisConnection = new IORedis({
  host: redisHost,
  port: redisPort,
  password: redisPassword || undefined,
  maxRetriesPerRequest: null,
});

// BullMQ использует собственный ioredis, поэтому передаём plain options
const bullmqConnection = {
  host: redisHost,
  port: redisPort,
  password: redisPassword || undefined,
  maxRetriesPerRequest: null as null,
};

export type QueueName =
  | "call_processing"
  | "history_sync"
  | "daily_reports"
  | "telegram_notifications"
  | "ai_coach";

export function createQueue(name: QueueName) {
  return new Queue(name, {
    connection: bullmqConnection,
    defaultJobOptions: defaultJobOptionsByQueue[name],
  });
}

export function createWorker(
  name: QueueName,
  processor: Processor
) {
  return new Worker(name, processor, {
    connection: bullmqConnection,
    concurrency: concurrencyByQueue[name],
  });
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

