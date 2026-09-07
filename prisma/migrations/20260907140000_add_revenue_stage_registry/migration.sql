-- Revenue stages are discovered from amoCRM instead of being hardcoded: only
-- UZUM's "Часть оплачена" ID was known, so every other pipeline's part-payments
-- were invisible to the report. /sync_stages fills this table and the webhook
-- reads it on each status change.
CREATE TABLE "RevenueStage" (
    "pipelineId" INTEGER NOT NULL,
    "statusId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "pipelineName" TEXT NOT NULL,
    "statusName" TEXT NOT NULL,
    "syncedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RevenueStage_pkey" PRIMARY KEY ("pipelineId", "statusId"),
    CONSTRAINT "RevenueStage_kind_check" CHECK ("kind" IN ('won', 'partial'))
);

CREATE INDEX "RevenueStage_kind_idx" ON "RevenueStage"("kind");
