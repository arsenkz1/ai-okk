import { createLeadInactivityAmoSubscriptionClient } from "./leadInactivityAmoSubscription";
import {
  LEAD_INACTIVITY_SUBSCRIPTION_CONFIRMATION,
  subscribeLeadInactivityEvents,
  type LeadInactivitySubscriptionClient,
} from "./leadInactivitySubscription";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type SubscriptionRunner = typeof subscribeLeadInactivityEvents;

export interface SubscribeConfiguredLeadInactivityEventsOptions {
  environment?: RuntimeEnvironment;
  createClient?: () => LeadInactivitySubscriptionClient;
  subscribe?: SubscriptionRunner;
}

function requiredEnvironment(environment: RuntimeEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Explicit one-deploy amoCRM subscription. It is invoked only after the
 * protected webhook has started listening, then the confirmation is removed.
 */
export async function subscribeConfiguredLeadInactivityEvents(
  options: SubscribeConfiguredLeadInactivityEventsOptions = {},
): Promise<boolean> {
  const environment = options.environment ?? process.env;
  const confirmation = environment.LEAD_INACTIVITY_SUBSCRIPTION_CONFIRM;
  if (!confirmation) return false;
  if (confirmation.trim().toLowerCase() !== LEAD_INACTIVITY_SUBSCRIPTION_CONFIRMATION) {
    throw new Error("refusing to subscribe amoCRM lead inactivity events; set LEAD_INACTIVITY_SUBSCRIPTION_CONFIRM=subscribe");
  }

  const createClient = options.createClient ?? (() => createLeadInactivityAmoSubscriptionClient({
    baseUrl: requiredEnvironment(environment, "AMOCRM_BASE_URL"),
    accessToken: requiredEnvironment(environment, "AMOCRM_ACCESS_TOKEN"),
    publicBaseUrl: requiredEnvironment(environment, "AMOCRM_INACTIVITY_PUBLIC_BASE_URL"),
    webhookSecret: requiredEnvironment(environment, "AMOCRM_INACTIVITY_WEBHOOK_SECRET"),
  }));
  const subscribe = options.subscribe ?? subscribeLeadInactivityEvents;
  await subscribe({ client: createClient(), confirmation });
  return true;
}
