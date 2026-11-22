-- AlterTable
ALTER TABLE "ScheduledWorkout" ADD COLUMN "linkedGarminActivityId" TEXT;
ALTER TABLE "ScheduledWorkout" ADD COLUMN "matchSource" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledWorkout_linkedGarminActivityId_key" ON "ScheduledWorkout"("linkedGarminActivityId");
