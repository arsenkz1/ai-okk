-- Not every amoCRM account synced from OnlinePBX is a salesperson: teams, ROP
-- and HR logins were appearing in the manager ranking alongside real sellers.
-- Whether an account sells is a business fact, so it is stored rather than
-- guessed from the account name.
ALTER TABLE "Manager" ADD COLUMN "excludeFromReports" BOOLEAN NOT NULL DEFAULT false;
