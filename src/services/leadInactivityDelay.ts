import { INACTIVITY_MS } from "./leadInactivityStore";

const HOUR_MS = 60 * 60 * 1000;
const MAX_INACTIVITY_DELAY_HOURS = 72;

export function resolveInactivityDelayMs(rawHours: string | undefined): number {
  const value = rawHours?.trim();
  if (!value) return INACTIVITY_MS;
  if (!/^\d+$/.test(value)) {
    throw new Error("AMOCRM_INACTIVITY_DELAY_HOURS must be a positive whole number of hours");
  }
  const hours = Number(value);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > MAX_INACTIVITY_DELAY_HOURS) {
    throw new Error(`AMOCRM_INACTIVITY_DELAY_HOURS must be a positive whole number of hours up to ${MAX_INACTIVITY_DELAY_HOURS}`);
  }
  return hours * HOUR_MS;
}

export function resolveTestingLeadMovementMode(rawValue: string | undefined): boolean {
  const normalized = rawValue?.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("TESTING_LEADS_MOVEMENT must be explicitly true or false when the inactivity worker is enabled");
}

export function assertUnrestrictedProductionDelay(testingMode: boolean, inactivityMs: number): void {
  if (!testingMode && inactivityMs !== INACTIVITY_MS) {
    throw new Error("unrestricted production mode requires AMOCRM_INACTIVITY_DELAY_HOURS=72");
  }
}
