import { prisma } from "../config/database";
import { initializeLeadInactivityActivation } from "./leadInactivityActivation";
import { createPrismaLeadInactivityPersistence } from "./leadInactivityPrismaPersistence";
import { createLeadInactivityStore, type LeadInactivityStore } from "./leadInactivityStore";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type ActivationInitializer = typeof initializeLeadInactivityActivation;

export interface InitializeConfiguredLeadInactivityActivationOptions {
  environment?: RuntimeEnvironment;
  createStore?: () => Pick<LeadInactivityStore, "getOrCreateActivationBoundary">;
  initialize?: ActivationInitializer;
}

/**
 * One-deploy, opt-in initializer used before registering amoCRM webhooks.
 * It runs before HTTP listening starts and is idempotent at the durable-store
 * layer; absence of the confirmation means no database mutation at all.
 */
export async function initializeConfiguredLeadInactivityActivation(
  options: InitializeConfiguredLeadInactivityActivationOptions = {},
): Promise<Date | null> {
  const confirmation = (options.environment ?? process.env).LEAD_INACTIVITY_ACTIVATION_CONFIRM;
  if (!confirmation) return null;

  const createStore = options.createStore ?? (() => (
    createLeadInactivityStore(createPrismaLeadInactivityPersistence(prisma))
  ));
  const initialize = options.initialize ?? initializeLeadInactivityActivation;
  return initialize({ store: createStore(), confirmation });
}
