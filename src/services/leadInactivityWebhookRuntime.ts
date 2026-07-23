import { prisma } from "../config/database";
import { createLeadInactivityWebhookRouter } from "../routes/leadInactivityWebhook";
import { createLeadInactivityAmoClient } from "./leadInactivityAmoClient";
import { createPrismaLeadInactivityPersistence } from "./leadInactivityPrismaPersistence";
import {
  assertUnrestrictedProductionDelay,
  resolveInactivityDelayMs,
  resolveTestingLeadMovementMode,
} from "./leadInactivityDelay";
import { createLeadInactivityStore, type LeadInactivityStore } from "./leadInactivityStore";
import { createLeadInactivityWebhookProcessor } from "./leadInactivityWebhook";

export type LeadInactivityEnvironment = Record<string, string | undefined>;

export interface LeadInactivityWebhookRuntimeDependencies {
  createStore?: (inactivityMs: number) => Pick<LeadInactivityStore, "recordLeadEvent">;
}

/**
 * The route is deliberately absent until a dedicated high-entropy path secret
 * is configured. The rollout code initializes the durable activation boundary
 * before registering amoCRM's separate subscription.
 */
export function createConfiguredLeadInactivityWebhookRouter(
  environment: LeadInactivityEnvironment = process.env,
  dependencies: LeadInactivityWebhookRuntimeDependencies = {},
) {
  const secret = environment.AMOCRM_INACTIVITY_WEBHOOK_SECRET?.trim();
  if (!secret) return null;

  const baseUrl = environment.AMOCRM_BASE_URL?.trim();
  const accessToken = environment.AMOCRM_ACCESS_TOKEN?.trim();
  if (!baseUrl || !accessToken) {
    throw new Error("AMOCRM_INACTIVITY_WEBHOOK_SECRET requires AMOCRM_BASE_URL and AMOCRM_ACCESS_TOKEN");
  }

  const inactivityMs = resolveInactivityDelayMs(environment.AMOCRM_INACTIVITY_DELAY_HOURS);
  if (environment.TESTING_LEADS_MOVEMENT !== undefined) {
    assertUnrestrictedProductionDelay(
      resolveTestingLeadMovementMode(environment.TESTING_LEADS_MOVEMENT),
      inactivityMs,
    );
  }
  const amo = createLeadInactivityAmoClient({ baseUrl, accessToken });
  const store = dependencies.createStore?.(inactivityMs) ?? createLeadInactivityStore(
    createPrismaLeadInactivityPersistence(prisma),
    { inactivityMs },
  );
  const processor = createLeadInactivityWebhookProcessor({ amo, store });
  return createLeadInactivityWebhookRouter({ secret, processor });
}
