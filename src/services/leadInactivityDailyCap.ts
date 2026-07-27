export const ALMATY_TIME_ZONE = "Asia/Almaty";
export const DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT = 50;

const almatyDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ALMATY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Returns the stable local-day key used for a durable daily movement bucket.
 * Capacity must reset at Almaty midnight, not at a process-local or UTC boundary.
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
