-- Raise durable movement capacity to 100 for 14:00 Asia/Almaty operational days.
-- Existing YYYY-MM-DD buckets remain untouched and retain their prior 50-slot
-- semantics until the next durable 14:00 boundary. New buckets are prefixed
-- with operational: to avoid reusing or rewriting in-flight legacy capacity.

ALTER TABLE "LeadInactivityDailyMovementSlot"
  DROP CONSTRAINT "LeadInactivityDailyMovementSlot_slotNumber_check";
ALTER TABLE "LeadInactivityDailyMovementSlot"
  ADD CONSTRAINT "LeadInactivityDailyMovementSlot_slotNumber_check"
  CHECK ("slotNumber" BETWEEN 1 AND 100);

ALTER TABLE "LeadInactivityDailyMovementSlot"
  DROP CONSTRAINT "LeadInactivityDailyMovementSlot_bucketDate_check";
ALTER TABLE "LeadInactivityDailyMovementSlot"
  ADD CONSTRAINT "LeadInactivityDailyMovementSlot_bucketDate_check"
  CHECK ("bucketDate" ~ '^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|operational:[0-9]{4}-[0-9]{2}-[0-9]{2})$');

-- All replicas read this once-per-database setting.  The first new 100-slot
-- day begins at the next 14:00 local boundary, never mid-period.
WITH local_clock AS (
  SELECT clock_timestamp() AT TIME ZONE 'Asia/Almaty' AS local_now
)
INSERT INTO "LeadInactivitySetting" ("key", "value", "createdAt", "updatedAt")
SELECT
  'lead_inactivity.daily_movement_operational_start_date',
  to_char(
    date_trunc('day', local_now)
      + CASE WHEN local_now::time < TIME '14:00:00' THEN INTERVAL '0 day' ELSE INTERVAL '1 day' END,
    'YYYY-MM-DD'
  ),
  clock_timestamp(),
  clock_timestamp()
FROM local_clock
ON CONFLICT ("key") DO NOTHING;
