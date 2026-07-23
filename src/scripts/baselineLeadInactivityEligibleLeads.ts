import "dotenv/config";
import { prisma } from "../config/database";
import { createLeadInactivityAmoClient } from "../services/leadInactivityAmoClient";
import { resolveInactivityDelayMs } from "../services/leadInactivityDelay";
import { createPrismaLeadInactivityPersistence } from "../services/leadInactivityPrismaPersistence";
import { runProductionLeadInactivityBaseline } from "../services/leadInactivityProductionBaseline";
import { createLeadInactivityStore } from "../services/leadInactivityStore";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolveDryRun(rawValue: string | undefined): boolean {
  const normalized = rawValue?.trim().toLowerCase() ?? "true";
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("LEAD_INACTIVITY_PRODUCTION_BASELINE_DRY_RUN must be true or false when configured");
}

async function main(): Promise<void> {
  const inactivityMs = resolveInactivityDelayMs(process.env.AMOCRM_INACTIVITY_DELAY_HOURS);
  const store = createLeadInactivityStore(
    createPrismaLeadInactivityPersistence(prisma),
    { inactivityMs },
  );
  const amo = createLeadInactivityAmoClient({
    baseUrl: requiredEnvironment("AMOCRM_BASE_URL"),
    accessToken: requiredEnvironment("AMOCRM_ACCESS_TOKEN"),
  });
  const result = await runProductionLeadInactivityBaseline({
    store,
    amo,
    confirmation: process.env.LEAD_INACTIVITY_PRODUCTION_BASELINE_CONFIRM,
    workerEnabled: process.env.AMOCRM_INACTIVITY_WORKER_ENABLED,
    testingMode: process.env.TESTING_LEADS_MOVEMENT,
    inactivityMs,
    dryRun: resolveDryRun(process.env.LEAD_INACTIVITY_PRODUCTION_BASELINE_DRY_RUN),
  });
  console.info(`[LeadInactivityProductionBaseline] dryRun=${result.dryRun} alreadyCompleted=${result.alreadyCompleted} baselineAt=${result.baselineAt?.toISOString() ?? "none"} discovered=${result.discovered} enrolled=${result.enrolled} alreadyBaselined=${result.alreadyBaselined}`);
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "lead inactivity production baseline failed");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
