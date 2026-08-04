-- CreateTable
CREATE TABLE "CallTaskAutomationSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CallTaskAutomationSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "CallTaskAction" (
    "id" TEXT NOT NULL,
    "callId" INTEGER NOT NULL,
    "actionKind" TEXT NOT NULL DEFAULT 'next_step',
    "dealId" INTEGER NOT NULL,
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'analyzing',
    "decision" TEXT,
    "taskText" TEXT,
    "evidence" TEXT,
    "proposedDueAt" TIMESTAMPTZ(3),
    "selectedDueAt" TIMESTAMPTZ(3),
    "responsibleUserId" INTEGER,
    "amoTaskId" INTEGER,
    "taskRequestId" TEXT,
    "noteText" TEXT,
    "amoNoteId" INTEGER,
    "approvalToken" TEXT NOT NULL,
    "reviewedByTelegramUserId" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "analysisLeaseToken" TEXT,
    "analysisLeaseExpiresAt" TIMESTAMPTZ(3),
    "analysisLeaseGeneration" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CallTaskAction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CallTaskAction_status_check" CHECK (
      "status" IN (
        'analyzing', 'proposed', 'creating_task', 'task_confirmed',
        'creating_note', 'confirmed', 'rejected', 'skipped', 'uncertain'
      )
    ),
    CONSTRAINT "CallTaskAction_decision_check" CHECK (
      "decision" IS NULL OR "decision" IN ('auto', 'review', 'none')
    )
);

-- CreateTable
CREATE TABLE "CallTaskAutomationTestSlot" (
    "slotNumber" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'free',
    "dealId" INTEGER,
    "actionId" TEXT,
    "reservedAt" TIMESTAMPTZ(3),
    "confirmedAt" TIMESTAMPTZ(3),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CallTaskAutomationTestSlot_pkey" PRIMARY KEY ("slotNumber"),
    CONSTRAINT "CallTaskAutomationTestSlot_state_check" CHECK (
      "state" IN ('free', 'reserved', 'confirmed', 'uncertain')
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "CallTaskAction_amoTaskId_key" ON "CallTaskAction"("amoTaskId");
CREATE UNIQUE INDEX "CallTaskAction_taskRequestId_key" ON "CallTaskAction"("taskRequestId");
CREATE UNIQUE INDEX "CallTaskAction_amoNoteId_key" ON "CallTaskAction"("amoNoteId");
CREATE UNIQUE INDEX "CallTaskAction_approvalToken_key" ON "CallTaskAction"("approvalToken");
CREATE INDEX "CallTaskAction_status_createdAt_idx" ON "CallTaskAction"("status", "createdAt");
CREATE INDEX "CallTaskAction_status_analysisLeaseExpiresAt_idx" ON "CallTaskAction"("status", "analysisLeaseExpiresAt");
CREATE INDEX "CallTaskAction_dealId_createdAt_idx" ON "CallTaskAction"("dealId", "createdAt");
CREATE UNIQUE INDEX "CallTaskAction_callId_actionKind_key" ON "CallTaskAction"("callId", "actionKind");
CREATE UNIQUE INDEX "CallTaskAutomationTestSlot_dealId_key" ON "CallTaskAutomationTestSlot"("dealId");
CREATE UNIQUE INDEX "CallTaskAutomationTestSlot_actionId_key" ON "CallTaskAutomationTestSlot"("actionId");
CREATE INDEX "CallTaskAutomationTestSlot_state_slotNumber_idx" ON "CallTaskAutomationTestSlot"("state", "slotNumber");
CREATE INDEX "CallTaskAutomationTestSlot_leaseExpiresAt_idx" ON "CallTaskAutomationTestSlot"("leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "CallTaskAction"
  ADD CONSTRAINT "CallTaskAction_callId_fkey"
  FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CallTaskAutomationTestSlot"
  ADD CONSTRAINT "CallTaskAutomationTestSlot_actionId_fkey"
  FOREIGN KEY ("actionId") REFERENCES "CallTaskAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
