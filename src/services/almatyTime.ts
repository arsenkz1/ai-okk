export const ALMATY_TIME_ZONE = "Asia/Almaty";

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function almatyParts(date: Date): LocalDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ALMATY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function parseDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function sameLocalDateTime(parts: LocalDateTimeParts, expected: LocalDateTimeParts): boolean {
  return parts.year === expected.year
    && parts.month === expected.month
    && parts.day === expected.day
    && parts.hour === expected.hour
    && parts.minute === expected.minute
    && parts.second === expected.second;
}

/**
 * Resolves a wall-clock date/time in Asia/Almaty using Intl rather than a
 * hard-coded UTC offset. Exact round-trip verification rejects invalid local
 * values instead of silently shifting them.
 */
export function almatyLocalDateTimeToUtc(dateInput: string, timeInput: string): Date | null {
  const date = parseDate(dateInput.trim());
  const time = parseTime(timeInput.trim());
  if (!date || !time) return null;
  const expected: LocalDateTimeParts = { ...date, ...time, second: 0 };
  const localAsUtcMs = Date.UTC(expected.year, expected.month - 1, expected.day, expected.hour, expected.minute, 0);
  const firstPass = new Date(localAsUtcMs);
  const observed = almatyParts(firstPass);
  const observedAsUtcMs = Date.UTC(
    observed.year,
    observed.month - 1,
    observed.day,
    observed.hour,
    observed.minute,
    observed.second,
  );
  const candidate = new Date(localAsUtcMs - (observedAsUtcMs - localAsUtcMs));
  return sameLocalDateTime(almatyParts(candidate), expected) ? candidate : null;
}

function localDateString(parts: Pick<LocalDateTimeParts, "year" | "month" | "day">): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addCalendarDaysInAlmaty(now: Date, days: number): string {
  const parts = almatyParts(now);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return localDateString({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}

export type AlmatyPreset = "today_18" | "tomorrow_10";

export function almatyPresetDueAt(preset: AlmatyPreset, now = new Date()): Date | null {
  if (preset === "today_18") return almatyLocalDateTimeToUtc(addCalendarDaysInAlmaty(now, 0), "18:00");
  if (preset === "tomorrow_10") return almatyLocalDateTimeToUtc(addCalendarDaysInAlmaty(now, 1), "10:00");
  return null;
}

export function parseAlmatyDateTimeInput(value: string): Date | null {
  const match = /^(?:(\d{2})\.(\d{2})\.(\d{4})|(\d{4})-(\d{2})-(\d{2}))\s+(\d{2}:\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = match[1]
    ? `${match[3]}-${match[2]}-${match[1]}`
    : `${match[4]}-${match[5]}-${match[6]}`;
  return almatyLocalDateTimeToUtc(date, match[7]);
}
