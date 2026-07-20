import "dotenv/config";
import { createLeadInactivityAmoSubscriptionClient } from "../services/leadInactivityAmoSubscription";
import { subscribeLeadInactivityEvents } from "../services/leadInactivitySubscription";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const client = createLeadInactivityAmoSubscriptionClient({
    baseUrl: requiredEnvironment("AMOCRM_BASE_URL"),
    accessToken: requiredEnvironment("AMOCRM_ACCESS_TOKEN"),
    publicBaseUrl: requiredEnvironment("AMOCRM_INACTIVITY_PUBLIC_BASE_URL"),
    webhookSecret: requiredEnvironment("AMOCRM_INACTIVITY_WEBHOOK_SECRET"),
  });
  await subscribeLeadInactivityEvents({
    client,
    confirmation: process.env.LEAD_INACTIVITY_SUBSCRIPTION_CONFIRM,
  });
  console.info("[LeadInactivitySubscription] amoCRM event subscription created");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "lead inactivity subscription failed");
  process.exitCode = 1;
});
