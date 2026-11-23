import type { createWorkoutRepository, StoredWorkout } from "../workouts";
import { type MatchPair, matchWorkouts } from "./match";
import type { Schedule } from "./schedule";

export interface PairableActivity {
  readonly garminActivityId: string;
  readonly sport: string | null;
  readonly startTime: Date;
}

export interface ResolvedPlan {
  readonly row: Schedule;
  // null when the stored workout is missing or corrupt
  readonly wk: StoredWorkout | null;
}

// Activities are bucketed by UTC day, matching how timestamps are displayed elsewhere.
export const dayOf = (a: { startTime: Date }): string => a.startTime.toISOString().slice(0, 10);

export async function resolvePlans(
  repo: ReturnType<typeof createWorkoutRepository>,
  byId: ReadonlyMap<string, StoredWorkout>,
  rows: readonly Schedule[],
): Promise<ResolvedPlan[]> {
  return Promise.all(
    rows.map(async (row) => {
      const cached = byId.get(row.workoutId);
      if (cached) return { row, wk: cached };
      return { row, wk: await repo.get(row.workoutId).catch(() => null) };
    }),
  );
}

// A manual link may point outside the visible range, so linked activities are fetched by id.
export const manualLinkIds = (rows: readonly Schedule[]): string[] =>
  rows.flatMap((r) =>
    r.matchSource === "manual" && r.linkedGarminActivityId !== null
      ? [r.linkedGarminActivityId]
      : [],
  );

// Shared by the calendar and the dashboard so both apply identical matching rules.
// Plans without a usable workout are not matched. A link is only honoured for matchSource "manual".
export function pairPlans(
  plans: readonly ResolvedPlan[],
  activities: readonly PairableActivity[],
): readonly MatchPair[] {
  return matchWorkouts(
    plans.flatMap(({ row, wk }) =>
      wk
        ? [
            {
              id: row.id,
              date: row.date,
              sport: wk.workout.sport,
              createdAt: row.createdAt,
              link: row.matchSource === "manual" ? row.linkedGarminActivityId : null,
              matchSource: row.matchSource,
            },
          ]
        : [],
    ),
    activities.map((a) => ({
      id: a.garminActivityId,
      day: dayOf(a),
      typeKey: a.sport,
      startTime: a.startTime,
    })),
  ).pairs;
}
