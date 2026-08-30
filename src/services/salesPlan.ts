import { prisma } from "../config/database";

/**
 * Monthly revenue targets. A target belongs to one manager and one Almaty
 * calendar month; a team's target is the sum of its members' targets.
 */

export const ALMATY_TIME_ZONE = "Asia/Almaty";
/** Guards against a mistyped target being stored as a real goal. */
export const MAX_PLAN_AMOUNT = 100_000_000_000;

export interface PlanMonth {
  year: number;
  month: number;
}

const almatyMonthFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ALMATY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
});

export function almatyPlanMonth(now: Date): PlanMonth {
  if (Number.isNaN(now.getTime())) throw new Error("plan month time is invalid");
  const parts = almatyMonthFormatter.formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new Error(`plan month is missing ${type}`);
    return Number(part);
  };
  return { year: value("year"), month: value("month") };
}

/** Parses a `YYYY-MM` argument; returns null when the value is unusable. */
export function parsePlanMonth(value: string): PlanMonth | null {
  const matched = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  if (year < 2020 || year > 2100 || month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * Parses a target written the way an operator types it: `50000000`, `50 000 000`
 * or `50млн`-free plain digits. Returns null for anything ambiguous.
 */
export function parsePlanAmount(value: string): number | null {
  const digits = value.trim().replace(/[\s ']/g, "");
  if (!/^\d{1,15}$/.test(digits)) return null;
  const parsed = Number(digits);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_PLAN_AMOUNT) return null;
  return parsed;
}

export function formatPlanMonth({ year, month }: PlanMonth): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export async function setManagerPlan(input: {
  managerId: number;
  month: PlanMonth;
  amountTarget: number;
  setByTelegramUserId?: string | null;
}): Promise<void> {
  await prisma.salesPlan.upsert({
    where: {
      managerId_year_month: {
        managerId: input.managerId,
        year: input.month.year,
        month: input.month.month,
      },
    },
    update: {
      amountTarget: BigInt(input.amountTarget),
      setByTelegramUserId: input.setByTelegramUserId ?? null,
    },
    create: {
      managerId: input.managerId,
      year: input.month.year,
      month: input.month.month,
      amountTarget: BigInt(input.amountTarget),
      setByTelegramUserId: input.setByTelegramUserId ?? null,
    },
  });
}

/** Returns the target amounts for the given managers, keyed by manager ID. */
export async function getManagerPlans(
  managerIds: readonly number[],
  month: PlanMonth,
): Promise<Map<number, number>> {
  if (managerIds.length === 0) return new Map();
  const plans = await prisma.salesPlan.findMany({
    where: { managerId: { in: [...managerIds] }, year: month.year, month: month.month },
    select: { managerId: true, amountTarget: true },
  });
  return new Map(plans.map((plan) => [plan.managerId, Number(plan.amountTarget)]));
}
