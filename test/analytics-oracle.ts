// Independent reference implementation for the analytics core. Deliberately naive and built on
// epoch day numbers (Hinnant civil algorithms), never on Date, so it shares no code path with the
// module under test.

export const DAY_MS = 86_400_000;

export const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const daysFromCivil = (year: number, month: number, day: number): number => {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

const pad = (n: number, w: number) => String(n).padStart(w, "0");

export const isoFromDays = (z0: number): string => {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
};

export const daysFromIso = (iso: string): number =>
  daysFromCivil(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const monthLength = (y: number, m: number) =>
  [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;

const NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface OraclePeriod {
  key: string;
  start: string;
  end: string;
  label: string;
  startDay: number;
  endDay: number;
}

// Monday = 0. 1970-01-01 (day 0) was a Thursday.
const mondayIndex = (day: number) => (((day + 3) % 7) + 7) % 7;

export function oraclePeriods(kind: "week" | "month", anchor: string, n: number): OraclePeriod[] {
  const out: OraclePeriod[] = [];
  const anchorDay = daysFromIso(anchor);
  if (kind === "week") {
    const thisMonday = anchorDay - mondayIndex(anchorDay);
    for (let i = 0; i < n; i++) {
      const startDay = thisMonday - 7 * (n - 1 - i);
      const start = isoFromDays(startDay);
      out.push({
        key: start,
        start,
        end: isoFromDays(startDay + 6),
        label: `Mon ${start}`,
        startDay,
        endDay: startDay + 6,
      });
    }
    return out;
  }
  let year = Number(anchor.slice(0, 4));
  let month = Number(anchor.slice(5, 7));
  for (let i = 0; i < n - 1; i++) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  for (let i = 0; i < n; i++) {
    const startDay = daysFromCivil(year, month, 1);
    const endDay = daysFromCivil(year, month, monthLength(year, month));
    out.push({
      key: `${pad(year, 4)}-${pad(month, 2)}`,
      start: isoFromDays(startDay),
      end: isoFromDays(endDay),
      label: `${NAMES[month - 1]} ${year}`,
      startDay,
      endDay,
    });
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

export interface OStats {
  count: number;
  durationSeconds: number;
  distanceMeters: number;
  durationKnown: number;
  distanceKnown: number;
}
const zero = (): OStats => ({
  count: 0,
  durationSeconds: 0,
  distanceMeters: 0,
  durationKnown: 0,
  distanceKnown: 0,
});

export interface OActivity {
  ms: number;
  sport: string | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
}

export const oracleSport = (raw: string | null): string => {
  if (raw === null) return "unknown";
  const s = raw.trim().toLowerCase();
  return s.length === 0 ? "unknown" : s;
};

export function oracleVolume(acts: OActivity[], periods: OraclePeriod[]) {
  const names: string[] = [];
  const rows: OStats[][] = [];
  const totals = periods.map(zero);
  for (const a of acts) {
    const day = Math.floor(a.ms / DAY_MS);
    let idx = -1;
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i] as OraclePeriod;
      if (day >= p.startDay && day <= p.endDay) idx = i;
    }
    if (idx < 0) continue;
    const sport = oracleSport(a.sport);
    let r = names.indexOf(sport);
    if (r < 0) {
      names.push(sport);
      rows.push(periods.map(zero));
      r = names.length - 1;
    }
    for (const t of [(rows[r] as OStats[])[idx] as OStats, totals[idx] as OStats]) {
      t.count += 1;
      if (a.durationSeconds !== null && a.durationSeconds >= 0 && a.durationSeconds < Infinity) {
        t.durationSeconds += a.durationSeconds;
        t.durationKnown += 1;
      }
      if (a.distanceMeters !== null && a.distanceMeters >= 0 && a.distanceMeters < Infinity) {
        t.distanceMeters += a.distanceMeters;
        t.distanceKnown += 1;
      }
    }
  }
  const sum = (xs: OStats[]) => {
    const t = zero();
    for (const x of xs) {
      t.count += x.count;
      t.durationSeconds += x.durationSeconds;
      t.distanceMeters += x.distanceMeters;
      t.durationKnown += x.durationKnown;
      t.distanceKnown += x.distanceKnown;
    }
    return t;
  };
  const sports = names.map((sport, i) => ({
    sport,
    perPeriod: rows[i] as OStats[],
    total: sum(rows[i] as OStats[]),
  }));
  sports.sort((a, b) =>
    a.total.durationSeconds !== b.total.durationSeconds
      ? b.total.durationSeconds - a.total.durationSeconds
      : a.sport < b.sport
        ? -1
        : a.sport > b.sport
          ? 1
          : 0,
  );
  return { sports, totals, overall: sum(totals) };
}

export interface OPlan {
  id: string;
  dayNo: number;
  matchSource: "manual" | "none" | null;
  workoutAvailable: boolean;
  plannedSeconds: number | null;
}

export function oraclePlans(
  plans: OPlan[],
  pairs: { scheduledId: string; actualSeconds: number | null }[],
  periods: OraclePeriod[],
  todayNo: number,
) {
  const rows = periods.map(() => ({
    due: 0,
    matched: 0,
    upcoming: 0,
    excludedNoMatch: 0,
    excludedUnavailable: 0,
    planned: 0,
    actual: 0,
    both: 0,
  }));
  for (const plan of plans) {
    const idx = periods.findIndex((p) => plan.dayNo >= p.startDay && plan.dayNo <= p.endDay);
    const row = rows[idx];
    if (!row) continue;
    if (plan.dayNo > todayNo) {
      row.upcoming++;
      continue;
    }
    if (!plan.workoutAvailable) {
      row.excludedUnavailable++;
      continue;
    }
    if (plan.matchSource === "none") {
      row.excludedNoMatch++;
      continue;
    }
    row.due++;
    const pair = pairs.find((p) => p.scheduledId === plan.id); // first pair wins
    if (!pair) continue;
    row.matched++;
    if (plan.plannedSeconds !== null && pair.actualSeconds !== null) {
      row.both++;
      row.planned += plan.plannedSeconds;
      row.actual += pair.actualSeconds;
    }
  }
  const fin = (r: (typeof rows)[number]) => ({
    due: r.due,
    matched: r.matched,
    upcoming: r.upcoming,
    excludedNoMatch: r.excludedNoMatch,
    excludedUnavailable: r.excludedUnavailable,
    ratio: r.due === 0 ? null : r.matched / r.due,
    time: {
      plannedSeconds: r.planned,
      actualSeconds: r.actual,
      pairsWithBoth: r.both,
      matched: r.matched,
      ratio: r.both === 0 || r.planned === 0 ? null : r.actual / r.planned,
    },
  });
  const all = rows.reduce(
    (t, r) => {
      for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += r[k];
      return t;
    },
    {
      ...rows[0],
      due: 0,
      matched: 0,
      upcoming: 0,
      excludedNoMatch: 0,
      excludedUnavailable: 0,
      planned: 0,
      actual: 0,
      both: 0,
    },
  );
  return { perPeriod: rows.map(fin), overall: fin(all) };
}

export function oracleDelta(
  prev: OStats,
  cur: OStats,
  field: "duration" | "distance",
): { absolute: number; percent: number } | null {
  const p = field === "duration" ? prev.durationSeconds : prev.distanceMeters;
  const c = field === "duration" ? cur.durationSeconds : cur.distanceMeters;
  const pk = field === "duration" ? prev.durationKnown : prev.distanceKnown;
  const ck = field === "duration" ? cur.durationKnown : cur.distanceKnown;
  if (!(p > 0)) return null;
  if (pk !== prev.count || ck !== cur.count) return null;
  return { absolute: c - p, percent: ((c - p) / p) * 100 };
}
