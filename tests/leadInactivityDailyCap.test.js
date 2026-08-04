const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT,
  LEGACY_DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT,
  almatyCalendarDay,
  almatyDailyMovementBucket,
  dailyMovementLimitForBucket,
} = require("../dist/services/leadInactivityDailyCap");

test("uses a stable Asia/Almaty calendar date for legacy daily movement buckets", () => {
  assert.equal(almatyCalendarDay(new Date("2026-07-27T18:59:59.999Z")), "2026-07-27");
  assert.equal(almatyCalendarDay(new Date("2026-07-27T19:00:00.000Z")), "2026-07-28");
});

test("starts the 100-move operational day at 14:00 Almaty without reusing legacy capacity", () => {
  const operationalStartDate = "2026-08-05";

  assert.equal(DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT, 100);
  assert.equal(LEGACY_DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT, 50);
  assert.equal(almatyDailyMovementBucket(new Date("2026-08-05T08:59:59.999Z"), operationalStartDate), "2026-08-05");
  assert.equal(dailyMovementLimitForBucket("2026-08-05"), 50);
  assert.equal(almatyDailyMovementBucket(new Date("2026-08-05T09:00:00.000Z"), operationalStartDate), "operational:2026-08-05");
  assert.equal(dailyMovementLimitForBucket("operational:2026-08-05"), 100);
  assert.equal(almatyDailyMovementBucket(new Date("2026-08-06T08:59:59.999Z"), operationalStartDate), "operational:2026-08-05");
  assert.equal(almatyDailyMovementBucket(new Date("2026-08-06T09:00:00.000Z"), operationalStartDate), "operational:2026-08-06");
});

test("forward migration expands slots to 100 and schedules the first operational reset at the next Almaty 14:00", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "..", "prisma", "migrations", "20260804170000_expand_lead_inactivity_operational_daily_cap", "migration.sql"),
    "utf8",
  );
  assert.match(migration, /DROP CONSTRAINT "LeadInactivityDailyMovementSlot_slotNumber_check"/);
  assert.match(migration, /"slotNumber" BETWEEN 1 AND 100/);
  assert.match(migration, /DROP CONSTRAINT "LeadInactivityDailyMovementSlot_bucketDate_check"/);
  assert.match(migration, /operational:/);
  assert.match(migration, /lead_inactivity\.daily_movement_operational_start_date/);
  assert.match(migration, /AT TIME ZONE 'Asia\/Almaty'/);
  assert.match(migration, /TIME '14:00:00'/);
  assert.match(migration, /ON CONFLICT \("key"\) DO NOTHING/);
});
