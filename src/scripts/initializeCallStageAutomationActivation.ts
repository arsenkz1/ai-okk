import "dotenv/config";
import { prisma } from "../config/database";
import {
  CALL_STAGE_AUTOMATION_HISTORY_FENCE_ACTIVATION_CONFIRMATION,
  initializeCallStageHistoryFenceActivation,
} from "../services/callStageAutomationActivation";
import { createPrismaCallStageAutomationStorePersistence } from "../services/callStageAutomationPrismaPersistence";
import { CALL_STAGE_AUTOMATION_HISTORY_FENCE_TEST_LIMIT, createCallStageAutomationStore } from "../services/callStageAutomationStore";

async function main(): Promise<void> {
  const store = createCallStageAutomationStore(createPrismaCallStageAutomationStorePersistence(prisma));
  const boundary = await initializeCallStageHistoryFenceActivation({
    store,
    confirmation: process.env.AMOCRM_CALL_STAGE_AUTOMATION_HISTORY_FENCE_ACTIVATION_CONFIRM,
  });
  console.info(
    `[CallStageAutomation] historyFenceBoundary=${boundary.toISOString()} newTestSlots=${CALL_STAGE_AUTOMATION_HISTORY_FENCE_TEST_LIMIT}`,
  );
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "call-stage activation failed");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());

export { CALL_STAGE_AUTOMATION_HISTORY_FENCE_ACTIVATION_CONFIRMATION };
