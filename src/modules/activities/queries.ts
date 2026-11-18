import type { Db } from "../../lib/db";

export const ACTIVITY_LIST_LIMIT = 500;

export function listActivities(db: Db) {
  return db.activity.findMany({
    take: ACTIVITY_LIST_LIMIT,
    orderBy: { startTime: "desc" },
    select: {
      garminActivityId: true,
      name: true,
      sport: true,
      startTime: true,
      durationSeconds: true,
      distanceMeters: true,
      syncStatus: true,
      lastSyncedAt: true,
      fitDownloadedAt: true,
    },
  });
}

export function latestSyncRun(db: Db) {
  return db.syncRun.findFirst({
    orderBy: { startedAt: "desc" },
    select: {
      status: true,
      startedAt: true,
      finishedAt: true,
      imported: true,
      updated: true,
      failed: true,
      errorMessage: true,
    },
  });
}
