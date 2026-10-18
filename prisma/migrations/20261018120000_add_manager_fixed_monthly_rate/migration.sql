-- The salary calculator in the bot needs each manager's fixed monthly rate;
-- it was only ever kept in a spreadsheet. Nullable: a manager without a rate
-- is told to ask an administrator or their team lead.
ALTER TABLE "Manager" ADD COLUMN "fixedMonthlyRate" BIGINT;
