-- Durable per-calendar-day movement capacity. The bucket is the Asia/Almaty
-- YYYY-MM-DD value calculated by the worker; it is intentionally not UTC.
-- Reserving a row before PATCH prevents cross-replica overshoot, while a row
-- retained as confirmed/uncertain never becomes reusable in that same day.

CREATE TABLE "LeadInactivityDailyMovementSlot" (
    "bucketDate" TEXT NOT NULL,
    "slotNumber" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'free',
    "leadId" INTEGER,
    "auditId" TEXT,
    "reservedAt" TIMESTAMPTZ(3),
    "confirmedAt" TIMESTAMPTZ(3),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LeadInactivityDailyMovementSlot_pkey" PRIMARY KEY ("bucketDate", "slotNumber"),
    CONSTRAINT "LeadInactivityDailyMovementSlot_bucketDate_check" CHECK ("bucketDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    CONSTRAINT "LeadInactivityDailyMovementSlot_slotNumber_check" CHECK ("slotNumber" BETWEEN 1 AND 50),
    CONSTRAINT "LeadInactivityDailyMovementSlot_state_check" CHECK ("state" IN ('free', 'reserved', 'confirmed', 'uncertain')),
    CONSTRAINT "LeadInactivityDailyMovementSlot_shape_check" CHECK (
      ("state" = 'free' AND "leadId" IS NULL AND "auditId" IS NULL AND "reservedAt" IS NULL AND "confirmedAt" IS NULL AND "leaseExpiresAt" IS NULL)
      OR
      ("state" = 'reserved' AND "leadId" IS NOT NULL AND "auditId" IS NOT NULL AND "reservedAt" IS NOT NULL AND "confirmedAt" IS NULL AND "leaseExpiresAt" IS NOT NULL)
      OR
      ("state" IN ('confirmed', 'uncertain') AND "leadId" IS NOT NULL AND "auditId" IS NOT NULL AND "reservedAt" IS NOT NULL AND "confirmedAt" IS NOT NULL AND "leaseExpiresAt" IS NULL)
    )
);

CREATE UNIQUE INDEX "LeadInactivityDailyMovementSlot_auditId_key"
  ON "LeadInactivityDailyMovementSlot"("auditId");
CREATE INDEX "LeadInactivityDailyMovementSlot_bucketDate_state_slotNumber_idx"
  ON "LeadInactivityDailyMovementSlot"("bucketDate", "state", "slotNumber");
CREATE INDEX "LeadInactivityDailyMovementSlot_bucketDate_leaseExpiresAt_idx"
  ON "LeadInactivityDailyMovementSlot"("bucketDate", "leaseExpiresAt");
