import type { Db } from "../../lib/db";
import { latestSyncRun } from "../activities";
import type { SetupCounts } from "./status";

export const NOT_READY: SetupCounts = {
  databaseReady: false,
  activityCount: 0,
  workoutCount: 0,
  scheduledCount: 0,
  lastSync: null,
};

// Never throws and never exposes the error: an unreachable or unmigrated database is "not ready".
export async function loadSetupCounts(db: Db): Promise<SetupCounts> {
  try {
    // Selecting the newest columns fails on a database whose migrations are not all applied.
    await db.scheduledWorkout.findFirst({
      select: { linkedGarminActivityId: true, matchSource: true },
    });
    const [activityCount, workoutCount, scheduledCount, run] = await Promise.all([
      db.activity.count(),
      db.workout.count({ where: { isTemplate: false } }),
      db.scheduledWorkout.count(),
      latestSyncRun(db),
    ]);
    return {
      databaseReady: true,
      activityCount,
      workoutCount,
      scheduledCount,
      lastSync: run && { status: run.status, startedAt: run.startedAt },
    };
  } catch {
    return NOT_READY;
  }
}
