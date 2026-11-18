-- AlterTable
ALTER TABLE "Activity" ADD COLUMN "fitDownloadedAt" DATETIME;
ALTER TABLE "Activity" ADD COLUMN "fitFile" BLOB;

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT
);
