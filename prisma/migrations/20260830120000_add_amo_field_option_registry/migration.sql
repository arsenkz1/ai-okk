-- Recovery data for AI-driven amoCRM option-list changes.
--
-- amoCRM has no per-option endpoint: adding one option means PATCHing the whole
-- enums array, and options left out of that array are deleted. The snapshot
-- below stores the untouched original list once per field, so the pre-automation
-- state is always recoverable.
CREATE TABLE "AmoFieldOptionSnapshot" (
    "fieldId" INTEGER NOT NULL,
    "fieldName" TEXT NOT NULL,
    "fieldType" TEXT NOT NULL,
    "originalEnums" JSONB NOT NULL,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmoFieldOptionSnapshot_pkey" PRIMARY KEY ("fieldId")
);

-- Every option this system added, so a rollback can remove exactly those and
-- leave options added by people untouched.
CREATE TABLE "AmoFieldOptionAddition" (
    "id" TEXT NOT NULL,
    "fieldId" INTEGER NOT NULL,
    "fieldName" TEXT NOT NULL,
    "enumId" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    "actionId" TEXT,
    "dealId" INTEGER,
    "revertedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmoFieldOptionAddition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AmoFieldOptionAddition_fieldId_enumId_key" ON "AmoFieldOptionAddition"("fieldId", "enumId");
CREATE INDEX "AmoFieldOptionAddition_fieldId_revertedAt_idx" ON "AmoFieldOptionAddition"("fieldId", "revertedAt");
CREATE INDEX "AmoFieldOptionAddition_createdAt_idx" ON "AmoFieldOptionAddition"("createdAt");
