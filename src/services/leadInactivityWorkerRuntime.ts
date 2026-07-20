import { prisma } from "../config/database";
import { notifyAdmins } from "../bot/notify";
import { createLeadInactivityAmoClient } from "./leadInactivityAmoClient";
import { createPrismaLeadInactivityPersistence } from "./leadInactivityPrismaPersistence";
import { resolveInactivityDelayMs } from "./leadInactivityDelay";
import { createLeadInactivityStore } from "./leadInactivityStore";
import {
  createLeadInactivityWorker,
  LEAD_INACTIVITY_WORKER_INTERVAL_MS,
  type LeadInactivityWorker,
  type LeadInactivityWorkerResult,
} from "../workers/leadInactivityWorker";

export type LeadInactivityWorkerEnvironment = Record<string, string | undefined>;

type TimerHandle = ReturnType<typeof setInterval>;
type Schedule = (callback: () => void | Promise<void>, intervalMs: number) => TimerHandle;
type ClearSchedule = (handle: TimerHandle) => void;

export interface LeadInactivityWorkerRuntime {
  runOnce(): Promise<void>;
  stop(): void;
}

export interface LeadInactivityWorkerRuntimeDependencies {
  createWorker?: () => LeadInactivityWorker;
  schedule?: Schedule;
  clearSchedule?: ClearSchedule;
  log?: (message: string, result?: LeadInactivityWorkerResult) => void;
}

export interface StartConfiguredLeadInactivityWorkerOptions {
  environment?: LeadInactivityWorkerEnvironment;
  dependencies?: LeadInactivityWorkerRuntimeDependencies;
}

export { resolveInactivityDelayMs };

function createProductionWorker(environment: LeadInactivityWorkerEnvironment): LeadInactivityWorker {
  const baseUrl = environment.AMOCRM_BASE_URL?.trim();
  const accessToken = environment.AMOCRM_ACCESS_TOKEN?.trim();
  if (!baseUrl || !accessToken) {
    throw new Error("AMOCRM_INACTIVITY_WORKER_ENABLED requires AMOCRM_BASE_URL and AMOCRM_ACCESS_TOKEN");
  }
  const store = createLeadInactivityStore(
    createPrismaLeadInactivityPersistence(prisma),
    { inactivityMs: resolveInactivityDelayMs(environment.AMOCRM_INACTIVITY_DELAY_HOURS) },
  );
  const amo = createLeadInactivityAmoClient({ baseUrl, accessToken });
  return createLeadInactivityWorker({ store, amo, notifyAdmins });
}

/**
 * Starts no eager pass: the first DB-backed claim happens only at the next full
 * one-minute interval. Each replica may schedule this timer; leases and slots
 * are the cross-replica coordination mechanism.
 */
export function startConfiguredLeadInactivityWorker(
  options: StartConfiguredLeadInactivityWorkerOptions = {},
): LeadInactivityWorkerRuntime | null {
  const environment = options.environment ?? process.env;
  const enabled = environment.AMOCRM_INACTIVITY_WORKER_ENABLED?.trim().toLowerCase();
  if (!enabled || enabled === "false") return null;
  if (enabled !== "true") {
    throw new Error("AMOCRM_INACTIVITY_WORKER_ENABLED must be true when configured");
  }
  if (environment.TESTING_LEADS_MOVEMENT?.trim().toLowerCase() !== "true") {
    throw new Error("AMOCRM_INACTIVITY_WORKER_ENABLED requires TESTING_LEADS_MOVEMENT=true");
  }
  if (!environment.AMOCRM_INACTIVITY_WEBHOOK_SECRET?.trim()) {
    throw new Error("AMOCRM_INACTIVITY_WORKER_ENABLED requires AMOCRM_INACTIVITY_WEBHOOK_SECRET");
  }

  const worker = options.dependencies?.createWorker?.() ?? createProductionWorker(environment);
  const schedule = options.dependencies?.schedule ?? ((callback, intervalMs) => setInterval(() => void callback(), intervalMs));
  const clearSchedule = options.dependencies?.clearSchedule ?? clearInterval;
  const log = options.dependencies?.log ?? ((message, result) => console.info(message, result));
  let running = false;

  const runOnce = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await worker.runOnce();
      log("[LeadInactivityWorker] pass completed", result);
    } catch {
      log("[LeadInactivityWorker] pass failed");
    } finally {
      running = false;
    }
  };

  const handle = schedule(runOnce, LEAD_INACTIVITY_WORKER_INTERVAL_MS);
  return {
    runOnce,
    stop: () => clearSchedule(handle),
  };
}
