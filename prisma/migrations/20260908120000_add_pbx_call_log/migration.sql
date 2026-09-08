-- Call volume used to come only from the OnlinePBX history API, so an expired
-- session key made the daily report show zero calls next to hundreds of scored
-- ones. Every call_end webhook is now stored as it arrives, which needs no
-- credentials and covers calls shorter than the six-minute analysis threshold.
CREATE TABLE "PbxCallLog" (
    "uuid" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "internalNumber" TEXT,
    "externalNumber" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "callSeconds" INTEGER NOT NULL,
    "talkSeconds" INTEGER NOT NULL,
    "hangupCause" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PbxCallLog_pkey" PRIMARY KEY ("uuid")
);

CREATE INDEX "PbxCallLog_startedAt_idx" ON "PbxCallLog"("startedAt");
CREATE INDEX "PbxCallLog_internalNumber_startedAt_idx" ON "PbxCallLog"("internalNumber", "startedAt");
