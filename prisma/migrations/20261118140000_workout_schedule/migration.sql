-- CreateTable
CREATE TABLE "ScheduledWorkout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workoutId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "remoteEventId" TEXT,
    "lastError" TEXT,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScheduledWorkout_workoutId_fkey" FOREIGN KEY ("workoutId") REFERENCES "Workout" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledWorkout_externalId_key" ON "ScheduledWorkout"("externalId");

-- CreateIndex
CREATE INDEX "ScheduledWorkout_date_idx" ON "ScheduledWorkout"("date");

-- CreateIndex
CREATE INDEX "ScheduledWorkout_status_idx" ON "ScheduledWorkout"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledWorkout_workoutId_date_key" ON "ScheduledWorkout"("workoutId", "date");
