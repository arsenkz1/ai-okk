import type { LeadInactivityStore } from "./leadInactivityStore";

export const LEAD_INACTIVITY_ACTIVATION_CONFIRMATION = "initialize";

export interface InitializeLeadInactivityActivationOptions {
  store: Pick<LeadInactivityStore, "getOrCreateActivationBoundary">;
  confirmation: string | undefined;
  now?: () => Date;
}

/**
 * Creates the no-backfill boundary exactly once. Calling it again reports the
 * existing durable boundary, so a rollout command cannot silently widen scope.
 */
export async function initializeLeadInactivityActivation(
  options: InitializeLeadInactivityActivationOptions,
): Promise<Date> {
  if (options.confirmation?.trim().toLowerCase() !== LEAD_INACTIVITY_ACTIVATION_CONFIRMATION) {
    throw new Error("refusing to initialize lead inactivity activation boundary; set LEAD_INACTIVITY_ACTIVATION_CONFIRM=initialize");
  }
  return options.store.getOrCreateActivationBoundary(options.now?.());
}
