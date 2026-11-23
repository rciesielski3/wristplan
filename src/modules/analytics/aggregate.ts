import type { Period } from "./periods";

export interface VolumeActivity {
  readonly day: string;
  readonly sport: string | null;
  readonly durationSeconds: number | null;
  readonly distanceMeters: number | null;
}

export interface VolumeStats {
  readonly count: number;
  readonly durationSeconds: number;
  readonly distanceMeters: number;
  readonly durationKnown: number;
  readonly distanceKnown: number;
}

export interface SportVolume {
  readonly sport: string;
  readonly perPeriod: readonly VolumeStats[];
  readonly total: VolumeStats;
}

export interface VolumeReport {
  readonly periods: readonly Period[];
  readonly sports: readonly SportVolume[];
  readonly totals: readonly VolumeStats[];
  readonly overall: VolumeStats;
}

type MutableStats = { -readonly [K in keyof VolumeStats]: VolumeStats[K] };

const emptyStats = (): MutableStats => ({
  count: 0,
  durationSeconds: 0,
  distanceMeters: 0,
  durationKnown: 0,
  distanceKnown: 0,
});

// NaN, Infinity and negatives are treated as unknown so sums stay finite and non-negative.
const isKnown = (v: number | null): v is number => v !== null && Number.isFinite(v) && v >= 0;

function add(target: MutableStats, a: Pick<VolumeActivity, "durationSeconds" | "distanceMeters">) {
  target.count += 1;
  if (isKnown(a.durationSeconds)) {
    target.durationSeconds += a.durationSeconds;
    target.durationKnown += 1;
  }
  if (isKnown(a.distanceMeters)) {
    target.distanceMeters += a.distanceMeters;
    target.distanceKnown += 1;
  }
}

function merge(target: MutableStats, s: VolumeStats) {
  target.count += s.count;
  target.durationSeconds += s.durationSeconds;
  target.distanceMeters += s.distanceMeters;
  target.durationKnown += s.durationKnown;
  target.distanceKnown += s.distanceKnown;
}

export const normalizeSport = (raw: string | null): string => {
  const sport = raw?.trim().toLowerCase();
  return sport ? sport : "unknown";
};

const periodIndex = (periods: readonly Period[], day: string): number =>
  periods.findIndex((p) => day >= p.start && day <= p.end);

const cmp = (a: string | number | null, b: string | number | null): number => {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
};

// Precondition: day is the caller-computed UTC YYYY-MM-DD (startTime.toISOString().slice(0, 10)).
// Inputs are sorted before summing so float sums do not depend on input order.
export function aggregateVolume(
  activities: readonly VolumeActivity[],
  periods: readonly Period[],
): VolumeReport {
  const sorted = activities
    .map((a) => ({ ...a, sport: normalizeSport(a.sport), index: periodIndex(periods, a.day) }))
    .filter((a) => a.index >= 0)
    .sort(
      (a, b) =>
        cmp(a.day, b.day) ||
        cmp(a.sport, b.sport) ||
        cmp(a.durationSeconds, b.durationSeconds) ||
        cmp(a.distanceMeters, b.distanceMeters),
    );
  const bySport = new Map<string, MutableStats[]>();
  const totals = periods.map(emptyStats);
  for (const a of sorted) {
    let row = bySport.get(a.sport);
    if (!row) {
      row = periods.map(emptyStats);
      bySport.set(a.sport, row);
    }
    const target = row[a.index];
    const total = totals[a.index];
    if (target && total) {
      add(target, a);
      add(total, a);
    }
  }
  const sumRow = (row: readonly VolumeStats[]): MutableStats => {
    const sum = emptyStats();
    for (const s of row) merge(sum, s);
    return sum;
  };
  const sports = [...bySport].map(([sport, perPeriod]) => ({
    sport,
    perPeriod,
    total: sumRow(perPeriod),
  }));
  sports.sort((a, b) => b.total.durationSeconds - a.total.durationSeconds || cmp(a.sport, b.sport));
  return { periods, sports, totals, overall: sumRow(totals) };
}

export interface PlanInput {
  readonly id: string;
  readonly date: string;
  readonly matchSource: "manual" | "none" | null;
  readonly workoutAvailable: boolean;
  readonly plannedSeconds: number | null;
}

export interface PairInput {
  readonly scheduledId: string;
  readonly actualSeconds: number | null;
}

export interface TimeComparison {
  readonly plannedSeconds: number;
  readonly actualSeconds: number;
  readonly pairsWithBoth: number;
  readonly matched: number;
  readonly ratio: number | null;
}

export interface PlanStats {
  readonly due: number;
  readonly matched: number;
  readonly upcoming: number;
  readonly excludedNoMatch: number;
  readonly excludedUnavailable: number;
  readonly ratio: number | null;
  readonly time: TimeComparison;
}

export interface PlanReport {
  readonly periods: readonly Period[];
  readonly perPeriod: readonly PlanStats[];
  readonly overall: PlanStats;
}

interface Counts {
  due: number;
  matched: number;
  upcoming: number;
  excludedNoMatch: number;
  excludedUnavailable: number;
  plannedSeconds: number;
  actualSeconds: number;
  pairsWithBoth: number;
}

const emptyCounts = (): Counts => ({
  due: 0,
  matched: 0,
  upcoming: 0,
  excludedNoMatch: 0,
  excludedUnavailable: 0,
  plannedSeconds: 0,
  actualSeconds: 0,
  pairsWithBoth: 0,
});

const toStats = (c: Counts): PlanStats => ({
  due: c.due,
  matched: c.matched,
  upcoming: c.upcoming,
  excludedNoMatch: c.excludedNoMatch,
  excludedUnavailable: c.excludedUnavailable,
  ratio: c.due === 0 ? null : c.matched / c.due,
  time: {
    plannedSeconds: c.plannedSeconds,
    actualSeconds: c.actualSeconds,
    pairsWithBoth: c.pairsWithBoth,
    matched: c.matched,
    ratio:
      c.pairsWithBoth === 0 || c.plannedSeconds === 0 ? null : c.actualSeconds / c.plannedSeconds,
  },
});

// Preconditions: valid YYYY-MM-DD dates, unique plan ids, `today` in the same day basis as the plans.
// Exclusions apply only to plans due on or before today; later plans are always "upcoming".
// Planned seconds are summed in id order so float sums do not depend on input order.
export function aggregatePlans(
  plans: readonly PlanInput[],
  pairs: readonly PairInput[],
  periods: readonly Period[],
  today: string,
): PlanReport {
  const actual = new Map<string, number | null>();
  for (const p of pairs) if (!actual.has(p.scheduledId)) actual.set(p.scheduledId, p.actualSeconds);
  const rows = periods.map(emptyCounts);
  const sorted = [...plans].sort((a, b) => cmp(a.id, b.id));
  for (const plan of sorted) {
    const c = rows[periodIndex(periods, plan.date)];
    if (!c) continue;
    if (plan.date > today) c.upcoming += 1;
    else if (!plan.workoutAvailable) c.excludedUnavailable += 1;
    else if (plan.matchSource === "none") c.excludedNoMatch += 1;
    else {
      c.due += 1;
      if (!actual.has(plan.id)) continue;
      c.matched += 1;
      const seconds = actual.get(plan.id) ?? null;
      if (plan.plannedSeconds !== null && seconds !== null) {
        c.pairsWithBoth += 1;
        c.plannedSeconds += plan.plannedSeconds;
        c.actualSeconds += seconds;
      }
    }
  }
  const overall = emptyCounts();
  for (const c of rows)
    for (const k of Object.keys(overall) as (keyof Counts)[]) overall[k] += c[k];
  return { periods, perPeriod: rows.map(toStats), overall: toStats(overall) };
}

export interface Delta {
  readonly absolute: number;
  readonly percent: number;
}

export interface TrendPoint {
  readonly periodKey: string;
  readonly duration: Delta | null;
  readonly distance: Delta | null;
  readonly estimate: true;
}

export interface TrendSeries {
  readonly sport: string | null;
  readonly points: readonly TrendPoint[];
}

function delta(
  prev: number,
  cur: number,
  prevKnown: number,
  curKnown: number,
  prevCount: number,
  curCount: number,
): Delta | null {
  if (prev <= 0 || prevKnown < prevCount || curKnown < curCount) return null;
  return { absolute: cur - prev, percent: ((cur - prev) / prev) * 100 };
}

function series(sport: string | null, periods: readonly Period[], row: readonly VolumeStats[]) {
  const points: TrendPoint[] = [];
  row.forEach((cur, i) => {
    const prev = row[i - 1];
    const period = periods[i];
    if (!prev || !period) return;
    points.push({
      periodKey: period.key,
      duration: delta(
        prev.durationSeconds,
        cur.durationSeconds,
        prev.durationKnown,
        cur.durationKnown,
        prev.count,
        cur.count,
      ),
      distance: delta(
        prev.distanceMeters,
        cur.distanceMeters,
        prev.distanceKnown,
        cur.distanceKnown,
        prev.count,
        cur.count,
      ),
      estimate: true,
    });
  });
  return { sport, points };
}

// Derived by this app from stored activities, not a Garmin metric: always flagged `estimate`.
export function computeTrend(volume: VolumeReport): {
  readonly overall: TrendSeries;
  readonly sports: readonly TrendSeries[];
} {
  return {
    overall: series(null, volume.periods, volume.totals),
    sports: volume.sports.map((s) => series(s.sport, volume.periods, s.perPeriod)),
  };
}
