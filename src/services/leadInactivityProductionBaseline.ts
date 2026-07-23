import { randomUUID } from "node:crypto";
import type { LeadInactivityAmoClient } from "./leadInactivityAmoClient";
import {
  INACTIVITY_MS,
  type LeadInactivityProductionBaselineInput,
  type LeadInactivityStore,
} from "./leadInactivityStore";

export const PRODUCTION_BASELINE_CONFIRMATION = "baseline_all_eligible_leads";

export interface ProductionLeadInactivityBaselineResult {
  baselineAt: Date | null;
  discovered: number;
  enrolled: number;
  alreadyBaselined: number;
  alreadyCompleted: boolean;
  dryRun: boolean;
}

export interface RunProductionLeadInactivityBaselineOptions {
  store: Pick<LeadInactivityStore, "beginProductionBaseline" | "recordProductionBaseline" | "completeProductionBaseline">;
  amo: Pick<LeadInactivityAmoClient, "listAllowedSourceStageLeads">;
  confirmation: string | undefined;
  workerEnabled: string | undefined;
  testingMode: string | undefined;
  inactivityMs: number;
  dryRun?: boolean;
  now?: () => Date;
  randomId?: () => string;
}

function normalizedBoolean(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function assertSafeBaselineConfiguration(options: RunProductionLeadInactivityBaselineOptions): void {
  if (!options.dryRun && options.confirmation?.trim().toLowerCase() !== PRODUCTION_BASELINE_CONFIRMATION) {
    throw new Error(`refusing to baseline inactive leads; set LEAD_INACTIVITY_PRODUCTION_BASELINE_CONFIRM=${PRODUCTION_BASELINE_CONFIRMATION}`);
  }
  if (normalizedBoolean(options.workerEnabled) !== "false") {
    throw new Error("refusing to baseline inactive leads; requires the inactivity worker to be explicitly disabled");
  }
  if (normalizedBoolean(options.testingMode) !== "false") {
    throw new Error("refusing to baseline inactive leads; requires TESTING_LEADS_MOVEMENT=false");
  }
  if (options.inactivityMs !== INACTIVITY_MS) {
    throw new Error("refusing to baseline inactive leads; requires a 72-hour delay");
  }
}

export async function runProductionLeadInactivityBaseline(
  options: RunProductionLeadInactivityBaselineOptions,
): Promise<ProductionLeadInactivityBaselineResult> {
  assertSafeBaselineConfiguration(options);
  if (options.dryRun) {
    const leads = await options.amo.listAllowedSourceStageLeads();
    return { baselineAt: null, discovered: leads.length, enrolled: 0, alreadyBaselined: 0, alreadyCompleted: false, dryRun: true };
  }
  const run = await options.store.beginProductionBaseline(options.randomId?.() ?? randomUUID(), options.now?.());
  if (run.alreadyCompleted) {
    return { baselineAt: run.baselineAt, discovered: 0, enrolled: 0, alreadyBaselined: 0, alreadyCompleted: true, dryRun: false };
  }
  const leads = await options.amo.listAllowedSourceStageLeads();
  const baselineAt = run.baselineAt;
  let enrolled = 0;
  let alreadyBaselined = 0;

  for (const lead of leads) {
    const input: LeadInactivityProductionBaselineInput = {
      leadId: lead.id,
      leadCreatedAt: lead.createdAt,
      pipelineId: lead.pipelineId,
      statusId: lead.statusId,
    };
    const recorded = await options.store.recordProductionBaseline(input, baselineAt);
    if (recorded.ignored) throw new Error(`production baseline unexpectedly ignored lead ${lead.id}`);
    if (recorded.duplicate) alreadyBaselined += 1;
    else enrolled += 1;
  }

  await options.store.completeProductionBaseline(run);
  return { baselineAt, discovered: leads.length, enrolled, alreadyBaselined, alreadyCompleted: false, dryRun: false };
}
