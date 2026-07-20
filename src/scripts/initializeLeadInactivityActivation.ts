import "dotenv/config";
import { prisma } from "../config/database";
import { initializeLeadInactivityActivation } from "../services/leadInactivityActivation";
import { createPrismaLeadInactivityPersistence } from "../services/leadInactivityPrismaPersistence";
import { createLeadInactivityStore } from "../services/leadInactivityStore";

async function main(): Promise<void> {
  const store = createLeadInactivityStore(createPrismaLeadInactivityPersistence(prisma));
  const boundary = await initializeLeadInactivityActivation({
    store,
    confirmation: process.env.LEAD_INACTIVITY_ACTIVATION_CONFIRM,
  });
  console.info(`[LeadInactivityActivation] durable boundary: ${boundary.toISOString()}`);
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "lead inactivity activation initialization failed");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
