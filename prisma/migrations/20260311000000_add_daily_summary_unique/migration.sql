-- AddUniqueConstraint to DailySummary: one record per manager per date per period
CREATE UNIQUE INDEX IF NOT EXISTS "DailySummary_managerId_date_period_key"
  ON "DailySummary"("managerId", "date", "period");
