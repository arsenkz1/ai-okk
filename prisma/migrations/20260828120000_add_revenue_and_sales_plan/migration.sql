-- Revenue reporting for the daily manager/team report.
--
-- Deal gains the amoCRM budget and responsible user so a recorded payment can
-- be valued and attributed without a second read at report time.
ALTER TABLE "Deal" ADD COLUMN "price" INTEGER;
ALTER TABLE "Deal" ADD COLUMN "responsibleUserId" INTEGER;

-- One entry of a deal into a revenue-bearing stage. The (dealId, statusId)
-- unique key makes a replayed amoCRM webhook idempotent and keeps one deal
-- from being counted twice for the same stage.
CREATE TABLE "DealPaymentEvent" (
    "id" TEXT NOT NULL,
    "dealId" INTEGER NOT NULL,
    "pipelineId" INTEGER NOT NULL,
    "statusId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "managerId" INTEGER,
    "amoUserId" INTEGER,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DealPaymentEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DealPaymentEvent_kind_check" CHECK ("kind" IN ('won', 'partial')),
    CONSTRAINT "DealPaymentEvent_amount_check" CHECK ("amount" IS NULL OR "amount" >= 0)
);

CREATE UNIQUE INDEX "DealPaymentEvent_dealId_statusId_key" ON "DealPaymentEvent"("dealId", "statusId");
CREATE INDEX "DealPaymentEvent_occurredAt_idx" ON "DealPaymentEvent"("occurredAt");
CREATE INDEX "DealPaymentEvent_managerId_occurredAt_idx" ON "DealPaymentEvent"("managerId", "occurredAt");
CREATE INDEX "DealPaymentEvent_kind_occurredAt_idx" ON "DealPaymentEvent"("kind", "occurredAt");

ALTER TABLE "DealPaymentEvent" ADD CONSTRAINT "DealPaymentEvent_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealPaymentEvent" ADD CONSTRAINT "DealPaymentEvent_managerId_fkey"
    FOREIGN KEY ("managerId") REFERENCES "Manager"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Monthly revenue target per manager. A team target is the sum of its members'
-- targets, so no separate team row exists.
CREATE TABLE "SalesPlan" (
    "id" SERIAL NOT NULL,
    "managerId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amountTarget" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "setByTelegramUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SalesPlan_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SalesPlan_month_check" CHECK ("month" BETWEEN 1 AND 12),
    CONSTRAINT "SalesPlan_year_check" CHECK ("year" BETWEEN 2020 AND 2100),
    CONSTRAINT "SalesPlan_amountTarget_check" CHECK ("amountTarget" >= 0)
);

CREATE UNIQUE INDEX "SalesPlan_managerId_year_month_key" ON "SalesPlan"("managerId", "year", "month");
CREATE INDEX "SalesPlan_year_month_idx" ON "SalesPlan"("year", "month");

ALTER TABLE "SalesPlan" ADD CONSTRAINT "SalesPlan_managerId_fkey"
    FOREIGN KEY ("managerId") REFERENCES "Manager"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
