import type { Db } from "../../lib/db";
import { ACTIVITY_LIST_LIMIT, formatDistance, formatDuration, formatText } from "../activities";
import { createWorkoutRepository, type StoredWorkout, summarizeWorkout } from "../workouts";
import { ScheduleListOverflowError } from "./errors";
import type { CalendarGrid } from "./grid";
import { type MatchScheduled, matchWorkouts } from "./match";
import { SCHEDULE_LIST_LIMIT, type ScheduleService, type ScheduleStatus } from "./schedule";

export type MatchState = "matched" | "no-match" | "missed" | "planned";

export interface MatchInfo {
  readonly activityId: string;
  readonly source: "auto" | "manual";
  // UTC day of the activity; differs from the plan's day for a manual cross-day link.
  readonly date: string;
  readonly activity: {
    readonly name: string;
    readonly sport: string;
    readonly durationSeconds: number | null;
    readonly distanceMeters: number | null;
    readonly startTime: Date;
  };
  readonly plannedSeconds: number | null;
  readonly deltaSeconds: number | null;
}

export interface LinkCandidate {
  readonly id: string;
  readonly label: string;
}

export interface ScheduledItem {
  readonly id: string;
  readonly date: string;
  readonly name: string;
  readonly summary: string;
  readonly status: ScheduleStatus;
  readonly lastError: string | null;
  readonly state: MatchState;
  readonly matchSource: "manual" | "none" | null;
  // A manual link whose activity row is gone; the plan then falls back to automatic matching.
  readonly linkMissing: boolean;
  readonly match: MatchInfo | null;
  // Nearest unpaired in-range activities (see CANDIDATE_WINDOW_DAYS, CANDIDATE_LIMIT).
  readonly linkCandidates: readonly LinkCandidate[];
}

export interface ActivityItem {
  readonly id: string;
  readonly name: string;
  readonly sport: string;
  readonly duration: string;
  readonly distance: string;
}

export interface CalendarDay {
  readonly scheduled: readonly ScheduledItem[];
  readonly activities: readonly ActivityItem[];
}

export interface CalendarData {
  readonly days: Readonly<Record<string, CalendarDay>>;
  readonly workouts: readonly { id: string; label: string }[];
  // User-facing notices; the view degrades instead of failing.
  readonly notices: readonly string[];
}

export const CANDIDATE_WINDOW_DAYS = 7;
export const CANDIDATE_LIMIT = 25;

export function formatDelta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "n/a";
  const abs = Math.round(Math.abs(seconds));
  if (abs === 0) return formatDuration(0);
  return `${seconds < 0 ? "-" : "+"}${formatDuration(abs)}`;
}

const UNAVAILABLE = "Unavailable workout";
const DAY_MS = 24 * 60 * 60 * 1000;

const describe = (
  stored: StoredWorkout,
): { name: string; summary: string; totalSeconds: number | null } => {
  const s = summarizeWorkout(stored.workout);
  const total = s.totalSeconds === null ? "" : `, ${formatDuration(s.totalSeconds)}`;
  return {
    name: stored.workout.name,
    totalSeconds: s.totalSeconds,
    summary: `${stored.workout.sport}, ${s.stepCount} step${s.stepCount === 1 ? "" : "s"}${total}`,
  };
};

export async function loadCalendar(
  db: Db,
  readService: () => ScheduleService,
  grid: CalendarGrid,
  today: string,
): Promise<CalendarData> {
  const notices: string[] = [];
  const repo = createWorkoutRepository(db);
  const { items: stored } = await repo.list();
  const byId = new Map(stored.map((s) => [s.id, s]));

  const scheduled = await readService()
    .list({ from: grid.from, to: grid.to })
    .catch((err: unknown) => {
      if (!(err instanceof ScheduleListOverflowError)) throw err;
      notices.push(
        `More than ${SCHEDULE_LIST_LIMIT} scheduled workouts in this range; none are shown. Try the week view.`,
      );
      return [];
    });

  // Activities are bucketed by UTC day, matching how timestamps are displayed elsewhere.
  const start = new Date(`${grid.from}T00:00:00.000Z`);
  const end = new Date(new Date(`${grid.to}T00:00:00.000Z`).getTime() + DAY_MS);
  const select = {
    garminActivityId: true,
    name: true,
    sport: true,
    startTime: true,
    durationSeconds: true,
    distanceMeters: true,
  } as const;
  const activities = await db.activity.findMany({
    where: { startTime: { gte: start, lt: end } },
    orderBy: { startTime: "asc" },
    take: ACTIVITY_LIST_LIMIT + 1,
    select,
  });
  if (activities.length > ACTIVITY_LIST_LIMIT) {
    notices.push(`More than ${ACTIVITY_LIST_LIMIT} activities in this range; the rest are hidden.`);
    activities.pop();
  }

  const resolved = await Promise.all(
    scheduled.map(async (row) => {
      const cached = byId.get(row.workoutId);
      if (cached) return { row, wk: cached };
      // missing or corrupt: keep a placeholder so the row can still be retried or removed
      return { row, wk: await repo.get(row.workoutId).catch(() => null) };
    }),
  );

  // A manual link may point outside the visible range, so linked activities are fetched by id.
  const linkIds = scheduled.flatMap((r) =>
    r.matchSource === "manual" && r.linkedGarminActivityId !== null
      ? [r.linkedGarminActivityId]
      : [],
  );
  const linked =
    linkIds.length === 0
      ? []
      : await db.activity.findMany({ where: { garminActivityId: { in: linkIds } }, select });
  const known = new Map([...linked, ...activities].map((a) => [a.garminActivityId, a]));
  const dayOf = (a: { startTime: Date }) => a.startTime.toISOString().slice(0, 10);

  const matchable: MatchScheduled[] = resolved.flatMap(({ row, wk }) =>
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
  );
  const { pairs } = matchWorkouts(
    matchable,
    [...known.values()].map((a) => ({
      id: a.garminActivityId,
      day: dayOf(a),
      typeKey: a.sport,
      startTime: a.startTime,
    })),
  );
  const pairBySchedule = new Map(pairs.map((p) => [p.scheduledId, p]));
  const paired = new Set(pairs.map((p) => p.activityId));

  const unpaired = activities
    .filter((a) => !paired.has(a.garminActivityId))
    .map((a) => {
      const d = dayOf(a);
      return {
        id: a.garminActivityId,
        label: `${formatText(a.name)}, ${d}, ${formatText(a.sport)}`,
        dayMs: Date.parse(`${d}T00:00:00.000Z`),
        startMs: a.startTime.getTime(),
      };
    });
  const candidatesFor = (date: string): LinkCandidate[] => {
    const planMs = Date.parse(`${date}T00:00:00.000Z`);
    return unpaired
      .map((u) => ({ ...u, dist: Math.abs(u.dayMs - planMs) / DAY_MS }))
      .filter((u) => u.dist <= CANDIDATE_WINDOW_DAYS)
      .sort((x, y) => x.dist - y.dist || x.startMs - y.startMs || (x.id < y.id ? -1 : 1))
      .slice(0, CANDIDATE_LIMIT)
      .map(({ id, label }) => ({ id, label }));
  };

  const days: Record<string, { scheduled: ScheduledItem[]; activities: ActivityItem[] }> = {};
  const day = (date: string) => {
    const existing = days[date];
    if (existing) return existing;
    const created = { scheduled: [], activities: [] };
    days[date] = created;
    return created;
  };

  for (const { row, wk } of resolved) {
    const info = wk ? describe(wk) : { name: UNAVAILABLE, summary: "", totalSeconds: null };
    const pair = pairBySchedule.get(row.id);
    const act = pair ? known.get(pair.activityId) : undefined;
    let match: MatchInfo | null = null;
    if (pair && act) {
      const actual = act.durationSeconds;
      match = {
        activityId: pair.activityId,
        source: pair.source,
        date: dayOf(act),
        activity: {
          name: formatText(act.name),
          sport: formatText(act.sport),
          durationSeconds: actual,
          distanceMeters: act.distanceMeters,
          startTime: act.startTime,
        },
        plannedSeconds: info.totalSeconds,
        deltaSeconds:
          actual !== null && info.totalSeconds !== null ? actual - info.totalSeconds : null,
      };
    }
    let state: MatchState = "planned";
    if (match) state = "matched";
    else if (row.matchSource === "none") state = "no-match";
    else if (row.date < today) state = "missed";
    day(row.date).scheduled.push({
      id: row.id,
      date: row.date,
      name: info.name,
      summary: info.summary,
      status: row.status,
      lastError: row.lastError,
      state,
      matchSource: row.matchSource,
      linkMissing:
        row.matchSource === "manual" &&
        row.linkedGarminActivityId !== null &&
        !known.has(row.linkedGarminActivityId),
      match,
      linkCandidates: candidatesFor(row.date),
    });
  }

  for (const a of activities) {
    if (paired.has(a.garminActivityId)) continue;
    day(dayOf(a)).activities.push({
      id: a.garminActivityId,
      name: formatText(a.name),
      sport: formatText(a.sport),
      duration: formatDuration(a.durationSeconds),
      distance: formatDistance(a.distanceMeters),
    });
  }

  return {
    days,
    workouts: stored.map((s) => ({
      id: s.id,
      label: s.isTemplate ? `${s.workout.name} (template)` : s.workout.name,
    })),
    notices,
  };
}
