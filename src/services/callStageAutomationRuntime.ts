import type { PrismaClient } from "../generated/prisma/client";
import { notifyCallStageAdmins } from "../bot/callStageNotifications";
import { prisma } from "../config/database";
import { analyzeCallStageRoutingWithGemini } from "./aiAnalysis";
import { createCallStageAmoClient } from "./callStageAmoClient";
import type { CallStageAutomationDependencies } from "./callStageAutomation";
import { createCallStageAutomationLedger } from "./callStageAutomationLedger";
import {
  createPrismaCallStageAutomationLedgerPersistence,
  createPrismaCallStageAutomationStorePersistence,
} from "./callStageAutomationPrismaPersistence";
import { createCallStageAutomationStore } from "./callStageAutomationStore";

export interface CallStageAutomationRuntimeConfig {
  enabled: boolean;
  testing: boolean;
  executionMode: "live" | "dry_run";
  baseUrl: string | null;
  accessToken: string | null;
}

export interface CallStageAutomationRuntime {
  config: CallStageAutomationRuntimeConfig;
  dependencies: CallStageAutomationDependencies;
}

function parseBoolean(value: string | undefined, name: string, defaultValue: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return defaultValue;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false when configured`);
}

export function parseCallStageAutomationRuntimeConfig(
  environment: Record<string, string | undefined> = process.env,
): CallStageAutomationRuntimeConfig {
  const enabled = parseBoolean(environment.AMOCRM_CALL_STAGE_AUTOMATION_ENABLED, "AMOCRM_CALL_STAGE_AUTOMATION_ENABLED", false);
  const testing = parseBoolean(environment.AMOCRM_CALL_STAGE_AUTOMATION_TESTING, "AMOCRM_CALL_STAGE_AUTOMATION_TESTING", true);
  if (!testing) {
    throw new Error("AMOCRM_CALL_STAGE_AUTOMATION_TESTING must remain true during the approved three-move rollout");
  }
  const rawExecutionMode = environment.AMOCRM_CALL_STAGE_AUTOMATION_EXECUTION_MODE?.trim().toLowerCase() || "dry_run";
  if (rawExecutionMode !== "live" && rawExecutionMode !== "dry_run") {
    throw new Error("AMOCRM_CALL_STAGE_AUTOMATION_EXECUTION_MODE must be live or dry_run");
  }
  const baseUrl = environment.AMOCRM_BASE_URL?.trim() || null;
  const accessToken = environment.AMOCRM_ACCESS_TOKEN?.trim() || null;
  if (enabled && (!baseUrl || !accessToken)) {
    throw new Error("AMOCRM_CALL_STAGE_AUTOMATION_ENABLED requires AMOCRM_BASE_URL and AMOCRM_ACCESS_TOKEN");
  }
  return { enabled, testing, executionMode: rawExecutionMode, baseUrl, accessToken };
}

export function createIsLatestCompletedCall(database: Pick<PrismaClient, "call"> = prisma) {
  return async (input: { callId: number; dealId: number; callEndedAt: Date }): Promise<boolean> => {
    const competing = await database.call.findFirst({
      where: {
        dealId: input.dealId,
        status: "completed",
        id: { not: input.callId },
        endedAt: { gte: input.callEndedAt },
      },
      select: { id: true },
    });
    // Equal end timestamps are treated as stale too: ties cannot safely prove
    // that this call is the latest customer agreement.
    return competing === null;
  };
}

export function createCallStageAutomationRuntime(
  environment: Record<string, string | undefined> = process.env,
): CallStageAutomationRuntime {
  const config = parseCallStageAutomationRuntimeConfig(environment);
  const store = createCallStageAutomationStore(createPrismaCallStageAutomationStorePersistence(prisma));
  const ledger = createCallStageAutomationLedger(createPrismaCallStageAutomationLedgerPersistence(prisma));
  const amo = config.enabled
    ? createCallStageAmoClient({ baseUrl: config.baseUrl!, accessToken: config.accessToken! })
    : null;

  return {
    config,
    dependencies: {
      enabled: config.enabled,
      testing: config.testing,
      executionMode: config.executionMode,
      isLatestCompletedCall: createIsLatestCompletedCall(),
      store,
      ledger,
      amo: amo ?? {
        async readLead() { throw new Error("call-stage automation is disabled"); },
        async getLeadCustomFields() { throw new Error("call-stage automation is disabled"); },
        async moveLeadToTarget() { throw new Error("call-stage automation is disabled"); },
        async addStageReasonNote() { throw new Error("call-stage automation is disabled"); },
      },
      analyze: analyzeCallStageRoutingWithGemini,
      notifier: config.enabled ? { notify: notifyCallStageAdmins } : undefined,
    },
  };
}

let runtime: CallStageAutomationRuntime | null = null;

export function getCallStageAutomationRuntime(): CallStageAutomationRuntime {
  if (!runtime) runtime = createCallStageAutomationRuntime();
  return runtime;
}
