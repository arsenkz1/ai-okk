import type { CallStageAutomationStore } from "./callStageAutomationStore";

export const CALL_STAGE_AUTOMATION_ACTIVATION_CONFIRMATION = "initialize";
export const CALL_STAGE_AUTOMATION_HISTORY_FENCE_ACTIVATION_CONFIRMATION = "initialize-history-fence";

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

export interface InitializeCallStageHistoryFenceActivationOptions {
  store: Pick<CallStageAutomationStore, "getOrCreateHistoryFenceActivationBoundary" | "ensureHistoryFenceTestSlots">;
  confirmation?: string;
  now?: () => Date;
}

/** Explicitly starts the separate five-move rollout after the 30-minute history fence is deployed. */
export async function initializeCallStageHistoryFenceActivation(
  options: InitializeCallStageHistoryFenceActivationOptions,
): Promise<Date> {
  if (options.confirmation?.trim().toLowerCase() !== CALL_STAGE_AUTOMATION_HISTORY_FENCE_ACTIVATION_CONFIRMATION) {
    throw new Error(
      "refusing to initialize call-stage history-fence boundary; "
      + "set AMOCRM_CALL_STAGE_AUTOMATION_HISTORY_FENCE_ACTIVATION_CONFIRM=initialize-history-fence",
    );
  }
  const boundary = await options.store.getOrCreateHistoryFenceActivationBoundary(options.now?.());
  await options.store.ensureHistoryFenceTestSlots();
  return boundary;
}
