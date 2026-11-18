-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "garminActivityId" TEXT NOT NULL,
    "name" TEXT,
    "sport" TEXT,
    "startTime" DATETIME NOT NULL,
    "durationSeconds" REAL,
    "distanceMeters" REAL,
    "syncStatus" TEXT NOT NULL DEFAULT 'synced',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastSyncedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Activity_garminActivityId_key" ON "Activity"("garminActivityId");
