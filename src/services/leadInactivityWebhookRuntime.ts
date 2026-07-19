import { prisma } from "../config/database";
import { createLeadInactivityWebhookRouter } from "../routes/leadInactivityWebhook";
import { createLeadInactivityAmoClient } from "./leadInactivityAmoClient";
import { createPrismaLeadInactivityPersistence } from "./leadInactivityPrismaPersistence";
import { createLeadInactivityStore } from "./leadInactivityStore";
import { createLeadInactivityWebhookProcessor } from "./leadInactivityWebhook";

export type LeadInactivityEnvironment = Record<string, string | undefined>;

/**
 * The route is deliberately absent until a dedicated high-entropy path secret
 * is configured. The rollout code initializes the durable activation boundary
 * before registering amoCRM's separate subscription.
 */
export function createConfiguredLeadInactivityWebhookRouter(environment: LeadInactivityEnvironment = process.env) {
  const secret = environment.AMOCRM_INACTIVITY_WEBHOOK_SECRET?.trim();
  if (!secret) return null;

  const baseUrl = environment.AMOCRM_BASE_URL?.trim();
  const accessToken = environment.AMOCRM_ACCESS_TOKEN?.trim();
  if (!baseUrl || !accessToken) {
    throw new Error("AMOCRM_INACTIVITY_WEBHOOK_SECRET requires AMOCRM_BASE_URL and AMOCRM_ACCESS_TOKEN");
  }

  const amo = createLeadInactivityAmoClient({ baseUrl, accessToken });
  const store = createLeadInactivityStore(createPrismaLeadInactivityPersistence(prisma));
  const processor = createLeadInactivityWebhookProcessor({ amo, store });
  return createLeadInactivityWebhookRouter({ secret, processor });
}
