import type { CallTaskAutomationStore } from "./callTaskAutomationStore";

export const CALL_TASK_AUTOMATION_ACTIVATION_CONFIRMATION = "initialize";

export interface InitializeCallTaskAutomationActivationOptions {
  store: Pick<CallTaskAutomationStore, "getOrCreateActivationBoundary">;
  confirmation?: string;
  now?: () => Date;
}

/**
 * The boundary is deliberately a separate explicit operation. Starting the
 * service must never silently enroll historical leads into task automation.
 */
export async function initializeCallTaskAutomationActivation(
  options: InitializeCallTaskAutomationActivationOptions,
): Promise<Date> {
  if (options.confirmation?.trim().toLowerCase() !== CALL_TASK_AUTOMATION_ACTIVATION_CONFIRMATION) {
    throw new Error(
      "refusing to initialize call-task activation boundary; " +
      "set AMOCRM_CALL_TASK_AUTOMATION_ACTIVATION_CONFIRM=initialize",
    );
  }
  return options.store.getOrCreateActivationBoundary(options.now?.());
}
