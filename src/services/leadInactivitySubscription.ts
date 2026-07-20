export const LEAD_INACTIVITY_SUBSCRIPTION_CONFIRMATION = "subscribe";

export interface LeadInactivitySubscriptionClient {
  subscribe(): Promise<void>;
}

export interface SubscribeLeadInactivityEventsOptions {
  client: LeadInactivitySubscriptionClient;
  confirmation: string | undefined;
}

/** A deliberately explicit external side effect: no subscription without confirmation. */
export async function subscribeLeadInactivityEvents(options: SubscribeLeadInactivityEventsOptions): Promise<void> {
  if (options.confirmation?.trim().toLowerCase() !== LEAD_INACTIVITY_SUBSCRIPTION_CONFIRMATION) {
    throw new Error("refusing to subscribe amoCRM lead inactivity events; set LEAD_INACTIVITY_SUBSCRIPTION_CONFIRM=subscribe");
  }
  await options.client.subscribe();
}
