type Logger = Pick<Console, "log" | "error">;

type NotifyFn = (text: string) => Promise<void>;

export interface StartupCheckDependencies {
  applyPilotDisciplineManagerConfig: () => Promise<unknown>;
  checkAndRestoreAmoCrmWebhook: (notifyFn: NotifyFn) => Promise<void>;
  notifyAdmins: NotifyFn;
  logger?: Logger;
}

async function runStartupStep(
  label: string,
  successMessage: string,
  failureMessage: string,
  task: () => Promise<unknown>,
  logger: Logger
): Promise<void> {
  logger.log(`[Startup] ${label}...`);
  try {
    await task();
    logger.log(successMessage);
  } catch (err: any) {
    logger.error(failureMessage, err?.message ?? err);
  }
}

export async function runStartupChecks({
  applyPilotDisciplineManagerConfig,
  checkAndRestoreAmoCrmWebhook,
  notifyAdmins,
  logger = console,
}: StartupCheckDependencies): Promise<void> {
  await runStartupStep(
    "Applying pilot discipline manager config",
    "[Startup] Pilot discipline manager config applied",
    "[Startup] Failed to apply pilot discipline config:",
    applyPilotDisciplineManagerConfig,
    logger
  );

  await runStartupStep(
    "Checking amoCRM webhook",
    "[Startup] amoCRM webhook check completed",
    "[Startup] Failed to check amoCRM webhook at startup:",
    () => checkAndRestoreAmoCrmWebhook(notifyAdmins),
    logger
  );
}
