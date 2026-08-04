export const ALMATY_TIME_ZONE = "Asia/Almaty";
/** Maximum confirmed or uncertain moves in one operational day beginning at 14:00 Almaty. */
export const DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT = 100;
/** Capacity retained only until the forward migration's first operational-day boundary. */
export const LEGACY_DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT = 50;
export const DAILY_MOVEMENT_OPERATIONAL_BUCKET_PREFIX = "operational:";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoCalendarDate(value: string): boolean {
  const matched = DATE_PATTERN.exec(value);
  if (!matched) return false;
  const [year, month, day] = matched.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

const almatyDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ALMATY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const almatyHourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ALMATY_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

/**
 * Returns the stable Almaty calendar date. Legacy capacity rows use this form.
 */
export function almatyCalendarDay(now: Date): string {
  if (Number.isNaN(now.getTime())) throw new Error("daily movement bucket time is invalid");
  const parts = almatyDateFormatter.formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new Error(`daily movement bucket is missing ${type}`);
    return part;
  };
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function almatyHour(now: Date): number {
  const value = almatyHourFormatter.formatToParts(now).find((part) => part.type === "hour")?.value;
  const hour = Number(value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("daily movement bucket hour is invalid");
  return hour;
}

function previousCalendarDate(date: string): string {
  if (!isIsoCalendarDate(date)) throw new Error("operational daily movement start date is invalid");
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

export function isOperationalDailyMovementBucket(bucketDate: string): boolean {
  return bucketDate.startsWith(DAILY_MOVEMENT_OPERATIONAL_BUCKET_PREFIX)
    && isIsoCalendarDate(bucketDate.slice(DAILY_MOVEMENT_OPERATIONAL_BUCKET_PREFIX.length));
}

/**
 * Preserves all legacy calendar capacity until the next durable 14:00 boundary.
 * From that boundary onward the bucket identifies the local date on which the
 * operational day began, so 00:00–13:59 belongs to the prior day's bucket.
 */
export function almatyDailyMovementBucket(now: Date, operationalStartDate: string): string {
  if (!isIsoCalendarDate(operationalStartDate)) {
    throw new Error("operational daily movement start date is invalid");
  }
  const calendarDate = almatyCalendarDay(now);
  const operationalDate = almatyHour(now) < 14 ? previousCalendarDate(calendarDate) : calendarDate;
  if (operationalDate < operationalStartDate) return calendarDate;
  return `${DAILY_MOVEMENT_OPERATIONAL_BUCKET_PREFIX}${operationalDate}`;
}

export function dailyMovementLimitForBucket(bucketDate: string): number {
  if (isOperationalDailyMovementBucket(bucketDate)) return DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT;
  if (isIsoCalendarDate(bucketDate)) return LEGACY_DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT;
  throw new Error("daily movement bucket date is invalid");
}
