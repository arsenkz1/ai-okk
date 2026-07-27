const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT,
  almatyCalendarDay,
} = require("../dist/services/leadInactivityDailyCap");

test("uses a stable Asia/Almaty calendar day for the daily movement bucket", () => {
  assert.equal(DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT, 50);
  assert.equal(almatyCalendarDay(new Date("2026-07-27T18:59:59.999Z")), "2026-07-27");
  assert.equal(almatyCalendarDay(new Date("2026-07-27T19:00:00.000Z")), "2026-07-28");
});

test("migration fixes exactly 50 daily slots and non-reusable uncertain capacity", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "..", "prisma", "migrations", "20260727120000_add_lead_inactivity_daily_movement_cap", "migration.sql"),
    "utf8",
  );
  assert.match(migration, /PRIMARY KEY \("bucketDate", "slotNumber"\)/);
  assert.match(migration, /"slotNumber" BETWEEN 1 AND 50/);
  assert.match(migration, /"state" IN \('free', 'reserved', 'confirmed', 'uncertain'\)/);
  assert.match(migration, /"state" IN \('confirmed', 'uncertain'\).*"leaseExpiresAt" IS NULL/s);
  assert.match(migration, /CREATE UNIQUE INDEX "LeadInactivityDailyMovementSlot_auditId_key"/);
});
