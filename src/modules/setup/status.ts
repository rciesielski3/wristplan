export interface SetupEnv {
  readonly GARMIN_PERSONAL_API_KEY?: string | undefined;
  readonly INTERVALS_API_KEY?: string | undefined;
}

export interface SetupCounts {
  readonly databaseReady: boolean;
  readonly activityCount: number;
  readonly workoutCount: number;
  readonly scheduledCount: number;
  readonly lastSync: { readonly status: string; readonly startedAt: Date } | null;
}

// Booleans and counts only: key values must never reach this shape.
export interface SetupStatus extends SetupCounts {
  readonly garminKeyConfigured: boolean;
  readonly intervalsKeyConfigured: boolean;
}

const present = (value: string | undefined): boolean => value !== undefined && value.trim() !== "";

export function getSetupStatus(env: SetupEnv, counts: SetupCounts): SetupStatus {
  return {
    garminKeyConfigured: present(env.GARMIN_PERSONAL_API_KEY),
    intervalsKeyConfigured: present(env.INTERVALS_API_KEY),
    databaseReady: counts.databaseReady,
    activityCount: counts.activityCount,
    workoutCount: counts.workoutCount,
    scheduledCount: counts.scheduledCount,
    lastSync: counts.lastSync && {
      status: counts.lastSync.status,
      startedAt: counts.lastSync.startedAt,
    },
  };
}
