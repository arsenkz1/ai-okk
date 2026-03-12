-- Add isActive and deactivatedAt to Manager
ALTER TABLE "Manager" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Manager" ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3);

-- Add unique constraint on amoUserId (allow NULL duplicates in Postgres)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Manager_amoUserId_key'
  ) THEN
    CREATE UNIQUE INDEX "Manager_amoUserId_key" ON "Manager"("amoUserId") WHERE "amoUserId" IS NOT NULL;
  END IF;
END$$;

-- Create BotAdmin table
CREATE TABLE IF NOT EXISTS "BotAdmin" (
  "id" SERIAL PRIMARY KEY,
  "telegramUserId" TEXT NOT NULL,
  "addedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "BotAdmin_telegramUserId_key" ON "BotAdmin"("telegramUserId");
