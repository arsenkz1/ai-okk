import "dotenv/config";
import { prisma } from "../config/database";
import {
  CALL_TASK_AUTOMATION_ACTIVATION_CONFIRMATION,
  initializeCallTaskAutomationActivation,
} from "../services/callTaskAutomationActivation";
import { createPrismaCallTaskAutomationPersistence } from "../services/callTaskAutomationPrismaPersistence";
import { CALL_TASK_AUTOMATION_TEST_LIMIT, createCallTaskAutomationStore } from "../services/callTaskAutomationStore";

async function main(): Promise<void> {
  const store = createCallTaskAutomationStore(createPrismaCallTaskAutomationPersistence(prisma));
  const boundary = await initializeCallTaskAutomationActivation({
    store,
    confirmation: process.env.AMOCRM_CALL_TASK_AUTOMATION_ACTIVATION_CONFIRM,
  });
  await store.ensureTestSlots(CALL_TASK_AUTOMATION_TEST_LIMIT);
  console.info(
    `[CallTaskAutomation] activation boundary=${boundary.toISOString()} testSlots=${CALL_TASK_AUTOMATION_TEST_LIMIT}`,
  );
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "call-task activation failed");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());

export { CALL_TASK_AUTOMATION_ACTIVATION_CONFIRMATION };
