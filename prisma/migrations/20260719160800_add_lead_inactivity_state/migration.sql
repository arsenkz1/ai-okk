-- Durable state for amoCRM lead inactivity tracking. These tables deliberately
-- have no foreign keys to Deal: an amoCRM webhook can arrive before legacy
-- PhoneMapping/Deal synchronization has created its local record.

CREATE TABLE "LeadInactivitySetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LeadInactivitySetting_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "LeadInactivityWatch" (
    "leadId" INTEGER NOT NULL,
    "leadCreatedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastActivityAt" TIMESTAMPTZ(3) NOT NULL,
    "lastActivityReceivedAt" TIMESTAMPTZ(3) NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "pipelineId" INTEGER NOT NULL,
    "statusId" INTEGER NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'watching', -- watching|leased|moved|outside_scope|skipped|uncertain
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
    "lastEventFingerprint" TEXT,
    "stoppedAt" TIMESTAMPTZ(3),
    "lastFailureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LeadInactivityWatch_pkey" PRIMARY KEY ("leadId")
);

CREATE TABLE "LeadInactivityEvent" (
    "id" SERIAL NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "leadId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadInactivityEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeadInactivityMoveAudit" (
    "id" TEXT NOT NULL,
    "leadId" INTEGER NOT NULL,
    "cycle" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "sourcePipelineId" INTEGER,
    "sourceStatusId" INTEGER,
    "targetPipelineId" INTEGER,
    "targetStatusId" INTEGER,
    "eventCutoffAt" TIMESTAMPTZ(3),
    "slotNumber" INTEGER,
    "patchHttpStatus" INTEGER,
    "readbackPipelineId" INTEGER,
    "readbackStatusId" INTEGER,
    "errorClass" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "LeadInactivityMoveAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeadInactivityTestSlot" (
    "slotNumber" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'free',
    "leadId" INTEGER,
    "auditId" TEXT,
    "reservedAt" TIMESTAMPTZ(3),
    "confirmedAt" TIMESTAMPTZ(3),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LeadInactivityTestSlot_pkey" PRIMARY KEY ("slotNumber"),
    CONSTRAINT "LeadInactivityTestSlot_slotNumber_check" CHECK ("slotNumber" BETWEEN 1 AND 5),
    CONSTRAINT "LeadInactivityTestSlot_state_check" CHECK ("state" IN ('free', 'reserved', 'confirmed', 'uncertain')),
    CONSTRAINT "LeadInactivityTestSlot_shape_check" CHECK (
      ("state" = 'free' AND "leadId" IS NULL AND "auditId" IS NULL AND "reservedAt" IS NULL AND "confirmedAt" IS NULL AND "leaseExpiresAt" IS NULL)
      OR
      ("state" = 'reserved' AND "leadId" IS NOT NULL AND "auditId" IS NOT NULL AND "reservedAt" IS NOT NULL AND "confirmedAt" IS NULL AND "leaseExpiresAt" IS NOT NULL)
      OR
      ("state" IN ('confirmed', 'uncertain') AND "leadId" IS NOT NULL AND "auditId" IS NOT NULL AND "reservedAt" IS NOT NULL AND "confirmedAt" IS NOT NULL AND "leaseExpiresAt" IS NULL)
    )
);

INSERT INTO "LeadInactivityTestSlot" ("slotNumber", "state", "updatedAt")
SELECT slot_number, 'free', CURRENT_TIMESTAMP
FROM generate_series(1, 5) AS slot_number;

CREATE UNIQUE INDEX "LeadInactivityEvent_fingerprint_key" ON "LeadInactivityEvent"("fingerprint");
CREATE UNIQUE INDEX "LeadInactivityTestSlot_auditId_key" ON "LeadInactivityTestSlot"("auditId");
CREATE INDEX "LeadInactivityWatch_state_dueAt_idx" ON "LeadInactivityWatch"("state", "dueAt");
CREATE INDEX "LeadInactivityWatch_leaseExpiresAt_idx" ON "LeadInactivityWatch"("leaseExpiresAt");
CREATE INDEX "LeadInactivityEvent_leadId_eventAt_idx" ON "LeadInactivityEvent"("leadId", "eventAt");
CREATE INDEX "LeadInactivityMoveAudit_leadId_createdAt_idx" ON "LeadInactivityMoveAudit"("leadId", "createdAt");
CREATE INDEX "LeadInactivityMoveAudit_outcome_idx" ON "LeadInactivityMoveAudit"("outcome");
CREATE INDEX "LeadInactivityTestSlot_state_slotNumber_idx" ON "LeadInactivityTestSlot"("state", "slotNumber");
CREATE INDEX "LeadInactivityTestSlot_leaseExpiresAt_idx" ON "LeadInactivityTestSlot"("leaseExpiresAt");
