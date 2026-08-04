import { analyzeCallTaskActionWithGemini } from "./aiAnalysis";
import { createCallTaskAmoClient } from "./callTaskAmoClient";
import type { CallTaskAutomationDependencies } from "./callTaskAutomation";
import { createCallTaskAutomationLedger } from "./callTaskAutomationLedger";
import { createPrismaCallTaskAutomationActionPersistence, createPrismaCallTaskAutomationPersistence } from "./callTaskAutomationPrismaPersistence";
import { createCallTaskAutomationStore } from "./callTaskAutomationStore";
import { createCallTaskReviewNotifier } from "../bot/callTaskReviewNotifications";
import { prisma } from "../config/database";

export interface CallTaskAutomationRuntimeConfig {
  enabled: boolean;
  testing: boolean;
  executionMode: "live" | "dry_run";
  taskTypeId: number;
  baseUrl: string | null;
  accessToken: string | null;
}

export interface CallTaskAutomationRuntime {
  config: CallTaskAutomationRuntimeConfig;
  dependencies: CallTaskAutomationDependencies;
}

function parseBoolean(value: string | undefined, name: string, defaultValue: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return defaultValue;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false when configured`);
}

function parsePositiveInteger(value: string | undefined, name: string, defaultValue: number): number {
  const normalized = value?.trim();
  if (!normalized) return defaultValue;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function parseCallTaskAutomationRuntimeConfig(
  environment: Record<string, string | undefined> = process.env,
): CallTaskAutomationRuntimeConfig {
  const enabled = parseBoolean(environment.AMOCRM_CALL_TASK_AUTOMATION_ENABLED, "AMOCRM_CALL_TASK_AUTOMATION_ENABLED", false);
  const testing = parseBoolean(environment.AMOCRM_CALL_TASK_AUTOMATION_TESTING, "AMOCRM_CALL_TASK_AUTOMATION_TESTING", true);
  const rawExecutionMode = environment.AMOCRM_CALL_TASK_AUTOMATION_EXECUTION_MODE?.trim().toLowerCase() || "dry_run";
  if (rawExecutionMode !== "live" && rawExecutionMode !== "dry_run") {
    throw new Error("AMOCRM_CALL_TASK_AUTOMATION_EXECUTION_MODE must be live or dry_run");
  }
  const taskTypeId = parsePositiveInteger(environment.AMOCRM_CALL_TASK_AUTOMATION_TASK_TYPE_ID, "AMOCRM_CALL_TASK_AUTOMATION_TASK_TYPE_ID", 1);
  const baseUrl = environment.AMOCRM_BASE_URL?.trim() || null;
  const accessToken = environment.AMOCRM_ACCESS_TOKEN?.trim() || null;
  if (enabled && (!baseUrl || !accessToken)) {
    throw new Error("AMOCRM_CALL_TASK_AUTOMATION_ENABLED requires AMOCRM_BASE_URL and AMOCRM_ACCESS_TOKEN");
  }
  return {
    enabled,
    testing,
    executionMode: rawExecutionMode,
    taskTypeId,
    baseUrl,
    accessToken,
  };
}

export function createCallTaskAutomationRuntime(
  environment: Record<string, string | undefined> = process.env,
): CallTaskAutomationRuntime {
  const config = parseCallTaskAutomationRuntimeConfig(environment);
  const store = createCallTaskAutomationStore(createPrismaCallTaskAutomationPersistence(prisma));
  const ledger = createCallTaskAutomationLedger(createPrismaCallTaskAutomationActionPersistence(prisma));
  // The disabled runtime intentionally has no amoCRM client. This means a
  // missing token can never turn an off feature into an accidental request.
  const amo = config.enabled
    ? createCallTaskAmoClient({
      baseUrl: config.baseUrl!,
      accessToken: config.accessToken!,
      taskTypeId: config.taskTypeId,
    })
    : null;

  return {
    config,
    dependencies: {
      enabled: config.enabled,
      testing: config.testing,
      executionMode: config.executionMode,
      store,
      ledger,
      amo: amo ?? {
        readLead: async () => { throw new Error("call-task automation is disabled"); },
        createVerifiedTask: async () => { throw new Error("call-task automation is disabled"); },
        addTaskReasonNote: async () => { throw new Error("call-task automation is disabled"); },
      },
      analyze: async (transcript, { now }) => analyzeCallTaskActionWithGemini(transcript, { now }),
      notifier: config.enabled ? createCallTaskReviewNotifier() : undefined,
    },
  };
}

let runtime: CallTaskAutomationRuntime | null = null;

export function getCallTaskAutomationRuntime(): CallTaskAutomationRuntime {
  if (!runtime) runtime = createCallTaskAutomationRuntime();
  return runtime;
}
