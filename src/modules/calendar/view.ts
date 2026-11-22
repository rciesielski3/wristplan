import type { Db } from "../../lib/db";
import { ACTIVITY_LIST_LIMIT, formatDistance, formatDuration, formatText } from "../activities";
import { createWorkoutRepository, type StoredWorkout, summarizeWorkout } from "../workouts";
import { ScheduleListOverflowError } from "./errors";
import type { CalendarGrid } from "./grid";
import { SCHEDULE_LIST_LIMIT, type ScheduleService, type ScheduleStatus } from "./schedule";

export interface ScheduledItem {
  readonly id: string;
  readonly date: string;
  readonly name: string;
  readonly summary: string;
  readonly status: ScheduleStatus;
  readonly lastError: string | null;
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

const UNAVAILABLE = "Unavailable workout";
const DAY_MS = 24 * 60 * 60 * 1000;

const describe = (stored: StoredWorkout): { name: string; summary: string } => {
  const s = summarizeWorkout(stored.workout);
  const total = s.totalSeconds === null ? "" : `, ${formatDuration(s.totalSeconds)}`;
  return {
    name: stored.workout.name,
    summary: `${stored.workout.sport}, ${s.stepCount} step${s.stepCount === 1 ? "" : "s"}${total}`,
  };
};

export async function loadCalendar(
  db: Db,
  readService: () => ScheduleService,
  grid: CalendarGrid,
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
  const activities = await db.activity.findMany({
    where: { startTime: { gte: start, lt: end } },
    orderBy: { startTime: "asc" },
    take: ACTIVITY_LIST_LIMIT + 1,
    select: {
      garminActivityId: true,
      name: true,
      sport: true,
      startTime: true,
      durationSeconds: true,
      distanceMeters: true,
    },
  });
  if (activities.length > ACTIVITY_LIST_LIMIT) {
    notices.push(`More than ${ACTIVITY_LIST_LIMIT} activities in this range; the rest are hidden.`);
    activities.pop();
  }

  const days: Record<string, { scheduled: ScheduledItem[]; activities: ActivityItem[] }> = {};
  const day = (date: string) => {
    const existing = days[date];
    if (existing) return existing;
    const created = { scheduled: [], activities: [] };
    days[date] = created;
    return created;
  };

  for (const row of scheduled) {
    let info = { name: UNAVAILABLE, summary: "" };
    const known = byId.get(row.workoutId);
    if (known) info = describe(known);
    else {
      try {
        info = describe(await repo.get(row.workoutId));
      } catch {
        // missing or corrupt: keep the placeholder so the row can still be retried or removed
      }
    }
    day(row.date).scheduled.push({
      id: row.id,
      date: row.date,
      ...info,
      status: row.status,
      lastError: row.lastError,
    });
  }
  for (const a of activities) {
    day(a.startTime.toISOString().slice(0, 10)).activities.push({
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
