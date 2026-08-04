-- CreateTable
CREATE TABLE "CallStageAutomationSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CallStageAutomationSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "CallStageAction" (
    "id" TEXT NOT NULL,
    "callId" INTEGER NOT NULL,
    "dealId" INTEGER NOT NULL,
    "testMode" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'analyzing',
    "decision" TEXT,
    "target" TEXT,
    "evidence" TEXT,
    "checkedFields" JSONB,
    "missingFields" JSONB,
    "amoNoteId" INTEGER,
    "failureReason" TEXT,
    "analysisLeaseToken" TEXT,
    "analysisLeaseExpiresAt" TIMESTAMPTZ(3),
    "analysisLeaseGeneration" INTEGER NOT NULL DEFAULT 0,
    "mutationLeaseToken" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CallStageAction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CallStageAction_status_check" CHECK (
      "status" IN (
        'analyzing', 'review', 'pending_move', 'moving',
        'blocked_missing_fields', 'confirmed', 'skipped', 'uncertain'
      )
    ),
    CONSTRAINT "CallStageAction_decision_check" CHECK (
      "decision" IS NULL OR "decision" IN ('move', 'review', 'none')
    )
);

-- CreateTable
CREATE TABLE "CallStageAutomationTestSlot" (
    "slotNumber" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'free',
    "dealId" INTEGER,
    "actionId" TEXT,
    "reservedAt" TIMESTAMPTZ(3),
    "confirmedAt" TIMESTAMPTZ(3),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CallStageAutomationTestSlot_pkey" PRIMARY KEY ("slotNumber"),
    CONSTRAINT "CallStageAutomationTestSlot_state_check" CHECK (
      "state" IN ('free', 'reserved', 'confirmed', 'uncertain')
    ),
    CONSTRAINT "CallStageAutomationTestSlot_slotNumber_check" CHECK ("slotNumber" BETWEEN 1 AND 3)
);

-- CreateIndex
CREATE UNIQUE INDEX "CallStageAction_callId_key" ON "CallStageAction"("callId");
CREATE UNIQUE INDEX "CallStageAction_amoNoteId_key" ON "CallStageAction"("amoNoteId");
CREATE INDEX "CallStageAction_status_createdAt_idx" ON "CallStageAction"("status", "createdAt");
CREATE INDEX "CallStageAction_status_analysisLeaseExpiresAt_idx" ON "CallStageAction"("status", "analysisLeaseExpiresAt");
CREATE INDEX "CallStageAction_dealId_createdAt_idx" ON "CallStageAction"("dealId", "createdAt");
CREATE UNIQUE INDEX "CallStageAutomationTestSlot_dealId_key" ON "CallStageAutomationTestSlot"("dealId");
CREATE UNIQUE INDEX "CallStageAutomationTestSlot_actionId_key" ON "CallStageAutomationTestSlot"("actionId");
CREATE INDEX "CallStageAutomationTestSlot_state_slotNumber_idx" ON "CallStageAutomationTestSlot"("state", "slotNumber");
CREATE INDEX "CallStageAutomationTestSlot_leaseExpiresAt_idx" ON "CallStageAutomationTestSlot"("leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "CallStageAction"
  ADD CONSTRAINT "CallStageAction_callId_fkey"
  FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CallStageAutomationTestSlot"
  ADD CONSTRAINT "CallStageAutomationTestSlot_actionId_fkey"
  FOREIGN KEY ("actionId") REFERENCES "CallStageAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
