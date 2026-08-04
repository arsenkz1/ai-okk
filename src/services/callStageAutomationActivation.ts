import type { CallStageAutomationStore } from "./callStageAutomationStore";

export const CALL_STAGE_AUTOMATION_ACTIVATION_CONFIRMATION = "initialize";

export interface InitializeCallStageAutomationActivationOptions {
  store: Pick<CallStageAutomationStore, "getOrCreateActivationBoundary">;
  confirmation?: string;
  now?: () => Date;
}

/** Service startup never silently enrolls historical UZUM calls. */
export async function initializeCallStageAutomationActivation(
  options: InitializeCallStageAutomationActivationOptions,
): Promise<Date> {
  if (options.confirmation?.trim().toLowerCase() !== CALL_STAGE_AUTOMATION_ACTIVATION_CONFIRMATION) {
    throw new Error(
      "refusing to initialize call-stage activation boundary; "
      + "set AMOCRM_CALL_STAGE_AUTOMATION_ACTIVATION_CONFIRM=initialize",
    );
  }
  return options.store.getOrCreateActivationBoundary(options.now?.());
}
