-- CreateEnum
CREATE TYPE "ManagerRole" AS ENUM ('MANAGER', 'TEAMLEAD', 'ROP');

-- CreateTable
CREATE TABLE "Team" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "teamLeadId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Manager"
    ADD COLUMN "role" "ManagerRole" NOT NULL DEFAULT 'MANAGER',
    ADD COLUMN "teamId" INTEGER,
    ADD COLUMN "isAmoCrmRestricted" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "amoRightsBeforeRestriction" JSONB;

-- AddForeignKey
ALTER TABLE "Manager" ADD CONSTRAINT "Manager_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
