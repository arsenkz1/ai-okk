import "dotenv/config";
import { prisma } from "../config/database";
import {
  CALL_STAGE_AUTOMATION_ACTIVATION_CONFIRMATION,
  initializeCallStageAutomationActivation,
} from "../services/callStageAutomationActivation";
import { createPrismaCallStageAutomationStorePersistence } from "../services/callStageAutomationPrismaPersistence";
import { CALL_STAGE_AUTOMATION_TEST_LIMIT, createCallStageAutomationStore } from "../services/callStageAutomationStore";

async function main(): Promise<void> {
  const store = createCallStageAutomationStore(createPrismaCallStageAutomationStorePersistence(prisma));
  const boundary = await initializeCallStageAutomationActivation({
    store,
    confirmation: process.env.AMOCRM_CALL_STAGE_AUTOMATION_ACTIVATION_CONFIRM,
  });
  await store.ensureTestSlots(CALL_STAGE_AUTOMATION_TEST_LIMIT);
  console.info(
    `[CallStageAutomation] activation boundary=${boundary.toISOString()} testSlots=${CALL_STAGE_AUTOMATION_TEST_LIMIT}`,
  );
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "call-stage activation failed");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());

export { CALL_STAGE_AUTOMATION_ACTIVATION_CONFIRMATION };
