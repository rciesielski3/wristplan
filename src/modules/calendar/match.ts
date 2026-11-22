import type { Workout } from "../workouts";

export type WorkoutSport = Workout["sport"];

export interface MatchScheduled {
  readonly id: string;
  readonly date: string;
  readonly sport: WorkoutSport;
  readonly createdAt: Date;
  readonly link: string | null;
  readonly matchSource: "manual" | "none" | null;
}

export interface MatchActivity {
  readonly id: string;
  readonly day: string;
  readonly typeKey: string | null;
  readonly startTime: Date;
}

export interface MatchPair {
  readonly scheduledId: string;
  readonly activityId: string;
  readonly source: "auto" | "manual";
}

export interface MatchResult {
  readonly pairs: readonly MatchPair[];
  readonly unmatchedScheduled: readonly string[];
  readonly unmatchedActivities: readonly string[];
}

// Unknown keys and run subtypes (e.g. trail_running) stay unmatched until real typeKeys are confirmed.
const SPORT_BY_TYPE_KEY: ReadonlyMap<string, WorkoutSport> = new Map([["running", "run"]]);

export const activitySport = (typeKey: string | null): WorkoutSport | null =>
  typeKey === null ? null : (SPORT_BY_TYPE_KEY.get(typeKey.trim().toLowerCase()) ?? null);

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

const byCreated = (a: MatchScheduled, b: MatchScheduled): number =>
  cmp(a.createdAt.getTime(), b.createdAt.getTime()) || cmp(a.id, b.id);

const byStart = (a: MatchActivity, b: MatchActivity): number =>
  cmp(a.startTime.getTime(), b.startTime.getTime()) || cmp(a.id, b.id);

// Preconditions: ids unique within each list; Dates valid (Invalid Date makes the comparators
// non-transitive); day/date are UTC YYYY-MM-DD from the caller; a link with matchSource null is manual.
export const matchWorkouts = (
  scheduled: readonly MatchScheduled[],
  activities: readonly MatchActivity[],
): MatchResult => {
  const activityById = new Map(activities.map((a) => [a.id, a]));
  const pairs: MatchPair[] = [];
  const usedActivities = new Set<string>();
  const handled = new Set<string>();

  for (const s of [...scheduled].sort(byCreated)) {
    if (s.matchSource === "none") {
      handled.add(s.id);
      continue;
    }
    if (s.link !== null && activityById.has(s.link)) {
      // A valid link that lost the claim stays unmatched instead of falling back to auto.
      handled.add(s.id);
      if (!usedActivities.has(s.link)) {
        usedActivities.add(s.link);
        pairs.push({ scheduledId: s.id, activityId: s.link, source: "manual" });
      }
    }
  }

  const groups = new Map<string, { s: MatchScheduled[]; a: MatchActivity[] }>();
  const group = (day: string, sport: WorkoutSport) => {
    const key = `${day}\u0000${sport}`;
    let g = groups.get(key);
    if (!g) {
      g = { s: [], a: [] };
      groups.set(key, g);
    }
    return g;
  };
  for (const s of scheduled) {
    if (!handled.has(s.id)) group(s.date, s.sport).s.push(s);
  }
  for (const a of activities) {
    const sport = activitySport(a.typeKey);
    if (sport !== null && !usedActivities.has(a.id)) group(a.day, sport).a.push(a);
  }
  for (const g of groups.values()) {
    const ss = g.s.sort(byCreated);
    const aa = g.a.sort(byStart);
    for (const [i, sch] of ss.entries()) {
      const act = aa[i];
      if (!act) break;
      usedActivities.add(act.id);
      pairs.push({ scheduledId: sch.id, activityId: act.id, source: "auto" });
    }
  }

  const pairedScheduled = new Set(pairs.map((p) => p.scheduledId));
  pairs.sort((x, y) => cmp(x.scheduledId, y.scheduledId));
  return {
    pairs,
    unmatchedScheduled: scheduled
      .map((s) => s.id)
      .filter((id) => !pairedScheduled.has(id))
      .sort(cmp),
    unmatchedActivities: activities
      .map((a) => a.id)
      .filter((id) => !usedActivities.has(id))
      .sort(cmp),
  };
};
