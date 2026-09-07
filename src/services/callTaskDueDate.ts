import { almatyLocalDateTimeToUtc, ALMATY_TIME_ZONE } from "./almatyTime";

/**
 * Turns the timing the transcript actually contains into a concrete due date.
 *
 * The agreed business rule is that a missing clock time is not a reason to ask a
 * human: an unspecified time means 10:00 Almaty. A bare month means the first
 * day of that month, and "ertaga" means tomorrow. Only a next step with no
 * timing at all still goes to review.
 */

/** Wall-clock hour used whenever the conversation named a day but no time. */
export const DEFAULT_TASK_HOUR = "10:00";

export type CallTaskDueHint =
  /** Both the day and the clock time were agreed. */
  | { kind: "exact"; at: string }
  /** A specific calendar day, no time: YYYY-MM-DD. */
  | { kind: "date"; date: string }
  /** A month with no day: YYYY-MM. */
  | { kind: "month"; month: string }
  /** "ertaga" / "завтра". */
  | { kind: "tomorrow" };

export type ResolveDueAtResult =
  | { kind: "resolved"; dueAt: Date; usedDefaultTime: boolean }
  | { kind: "unresolved"; reason: "no_hint" | "invalid_hint" | "not_in_future" };

interface AlmatyDayParts {
  year: number;
  month: number;
  day: number;
}

function almatyToday(now: Date): AlmatyDayParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ALMATY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): number => (
    Number(parts.find((part) => part.type === type)?.value)
  );
  return { year: value("year"), month: value("month"), day: value("day") };
}

function isoDate({ year, month, day }: AlmatyDayParts): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function tomorrowInAlmaty(now: Date): string {
  const today = almatyToday(now);
  const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return isoDate({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() });
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isIsoMonth(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

/**
 * Resolves the hint into an absolute instant. Anything that would land in the
 * past is rejected rather than silently pushed forward: a task dated before now
 * is invisible to the manager it was created for.
 */
export function resolveCallTaskDueAt(
  hint: CallTaskDueHint | null,
  now: Date,
): ResolveDueAtResult {
  if (!hint) return { kind: "unresolved", reason: "no_hint" };

  if (hint.kind === "exact") {
    const at = new Date(hint.at);
    if (Number.isNaN(at.getTime())) return { kind: "unresolved", reason: "invalid_hint" };
    if (at.getTime() <= now.getTime()) return { kind: "unresolved", reason: "not_in_future" };
    return { kind: "resolved", dueAt: at, usedDefaultTime: false };
  }

  let date: string;
  if (hint.kind === "tomorrow") {
    date = tomorrowInAlmaty(now);
  } else if (hint.kind === "date") {
    if (!isIsoDate(hint.date)) return { kind: "unresolved", reason: "invalid_hint" };
    date = hint.date;
  } else {
    if (!isIsoMonth(hint.month)) return { kind: "unresolved", reason: "invalid_hint" };
    // A month with no day means its first day.
    date = `${hint.month}-01`;
  }

  const dueAt = almatyLocalDateTimeToUtc(date, DEFAULT_TASK_HOUR);
  if (!dueAt) return { kind: "unresolved", reason: "invalid_hint" };
  if (dueAt.getTime() <= now.getTime()) return { kind: "unresolved", reason: "not_in_future" };
  return { kind: "resolved", dueAt, usedDefaultTime: true };
}
