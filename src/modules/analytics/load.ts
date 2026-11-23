import type { Db } from "../../lib/db";
import { formatTimestamp, latestSyncRun } from "../activities";
import {
  dayOf,
  manualLinkIds,
  pairPlans,
  parseAnchor,
  resolvePlans,
  SCHEDULE_LIST_LIMIT,
  toSchedule,
} from "../calendar";
import { createWorkoutRepository, summarizeWorkout } from "../workouts";
import {
  aggregatePlans,
  aggregateVolume,
  computeTrend,
  type PlanReport,
  type VolumeReport,
} from "./aggregate";
import {
  buildPeriods,
  type PeriodKind,
  type PeriodSet,
  parsePeriodCount,
  parsePeriodKind,
} from "./periods";

export const DASHBOARD_ACTIVITY_LIMIT = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DashboardParams {
  readonly kind: PeriodKind;
  readonly count: number;
  readonly anchor: string;
}

export interface DashboardData {
  readonly periodSet: PeriodSet;
  readonly volume: VolumeReport;
  // plans is null on either cap (ratios would mislead); trend is null only when the activity cap truncated volume.
  readonly plans: PlanReport | null;
  readonly trend: ReturnType<typeof computeTrend> | null;
  readonly notices: readonly string[];
  readonly lastSync: string | null;
  readonly activityCount: number;
  readonly planCount: number;
  readonly partial: boolean;
}

export async function loadDashboard(
  db: Db,
  params: DashboardParams,
  today: string,
): Promise<DashboardData> {
  const kind = parsePeriodKind(params.kind);
  const periodSet = buildPeriods(
    kind,
    parseAnchor(params.anchor, today),
    parsePeriodCount(kind, String(params.count)),
  );
  const notices: string[] = [];

  const select = {
    garminActivityId: true,
    sport: true,
    startTime: true,
    durationSeconds: true,
    distanceMeters: true,
  } as const;
  const activities = await db.activity.findMany({
    where: {
      startTime: {
        gte: new Date(`${periodSet.from}T00:00:00.000Z`),
        lt: new Date(new Date(`${periodSet.to}T00:00:00.000Z`).getTime() + DAY_MS),
      },
    },
    orderBy: { startTime: "desc" },
    take: DASHBOARD_ACTIVITY_LIMIT + 1,
    select,
  });
  const rows = await db.scheduledWorkout.findMany({
    where: { date: { gte: periodSet.from, lte: periodSet.to } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
    take: SCHEDULE_LIST_LIMIT + 1,
  });

  let partial = false;
  let volumeIncomplete = false;
  if (activities.length > DASHBOARD_ACTIVITY_LIMIT) {
    // newest first, so the probe row is the oldest
    activities.pop();
    partial = true;
    volumeIncomplete = true;
    notices.push(
      `More than ${DASHBOARD_ACTIVITY_LIMIT} activities in this range; the oldest are omitted and totals are incomplete. Choose a shorter range.`,
    );
  }
  if (rows.length > SCHEDULE_LIST_LIMIT) {
    rows.pop();
    partial = true;
    notices.push(
      `More than ${SCHEDULE_LIST_LIMIT} scheduled workouts in this range; plan statistics are incomplete. Choose a shorter range.`,
    );
  }
  const scheduled = rows.map(toSchedule);

  const repo = createWorkoutRepository(db);
  const { items: stored } = await repo.list();
  const resolved = await resolvePlans(repo, new Map(stored.map((s) => [s.id, s])), scheduled);

  const linkIds = manualLinkIds(scheduled);
  const linked =
    linkIds.length === 0
      ? []
      : await db.activity.findMany({ where: { garminActivityId: { in: linkIds } }, select });
  const known = new Map([...linked, ...activities].map((a) => [a.garminActivityId, a]));
  const pairs = pairPlans(resolved, [...known.values()]);

  const volume = aggregateVolume(
    activities.map((a) => ({
      day: dayOf(a),
      sport: a.sport,
      durationSeconds: a.durationSeconds,
      distanceMeters: a.distanceMeters,
    })),
    periodSet.periods,
  );
  const plans = aggregatePlans(
    resolved.map(({ row, wk }) => ({
      id: row.id,
      date: row.date,
      matchSource: row.matchSource,
      workoutAvailable: wk !== null,
      plannedSeconds: wk ? summarizeWorkout(wk.workout).totalSeconds : null,
    })),
    pairs.map((p) => ({
      scheduledId: p.scheduledId,
      actualSeconds: known.get(p.activityId)?.durationSeconds ?? null,
    })),
    periodSet.periods,
    today,
  );

  const run = await latestSyncRun(db);
  return {
    periodSet,
    volume,
    plans: partial ? null : plans,
    trend: volumeIncomplete ? null : computeTrend(volume),
    notices,
    lastSync: run
      ? `${run.status} (${formatTimestamp(run.startedAt)}), ${run.imported} imported, ${run.updated} updated, ${run.failed} failed`
      : null,
    activityCount: activities.length,
    planCount: scheduled.length,
    partial,
  };
}
