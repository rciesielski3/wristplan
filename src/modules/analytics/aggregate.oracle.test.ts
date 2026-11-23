import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  daysFromCivil,
  isoFromDays,
  mulberry32,
  type OActivity,
  type OPlan,
  type OStats,
  oracleDelta,
  oraclePeriods,
  oraclePlans,
  oracleVolume,
} from "../../../test/analytics-oracle";
import {
  aggregatePlans,
  aggregateVolume,
  computeTrend,
  type PairInput,
  type PlanInput,
  type VolumeActivity,
} from "./aggregate";
import { buildPeriods, PERIOD_COUNTS, type PeriodKind } from "./periods";

const MIN = daysFromCivil(1970, 1, 1);
const MAX = daysFromCivil(2100, 12, 31);
const SPORTS = [
  "running",
  "Running",
  " running ",
  "RUNNING\t",
  "cycling",
  "trail_running",
  "Trail_Running",
  "",
  "   ",
  null,
  "unknown",
  "UNKNOWN",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "toString",
  "ünïcode",
];

const toVolume = (a: OActivity): VolumeActivity => ({
  day: new Date(a.ms).toISOString().slice(0, 10),
  sport: a.sport,
  durationSeconds: a.durationSeconds,
  distanceMeters: a.distanceMeters,
});

function randomActivities(
  rnd: () => number,
  periods: ReturnType<typeof oraclePeriods>,
  count: number,
): OActivity[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const lo = (periods[0]?.startDay ?? 0) - 3;
  const hi = (periods[periods.length - 1]?.endDay ?? 0) + 3;
  const boundaries = periods.flatMap((p) => [p.startDay, p.endDay]);
  return Array.from({ length: count }, () => {
    const roll = rnd();
    // 40%: exact boundary instants (00:00:00.000Z / 23:59:59.999Z) of period edge days and their neighbours.
    const day =
      roll < 0.4 ? pick(boundaries) + pick([-1, 0, 0, 1]) : lo + Math.floor(rnd() * (hi - lo + 1));
    const ms = day * DAY_MS + pick([0, DAY_MS - 1, Math.floor(rnd() * DAY_MS)]);
    return {
      ms,
      sport: pick(SPORTS),
      durationSeconds: rnd() < 0.2 ? null : Math.floor(rnd() * 20000),
      distanceMeters: rnd() < 0.2 ? null : Math.floor(rnd() * 90000),
    };
  });
}

const KINDS: PeriodKind[] = ["week", "month"];

describe("aggregateVolume against an independent oracle", () => {
  for (const kind of KINDS) {
    for (const n of PERIOD_COUNTS[kind]) {
      it(`${kind} x${n}: 150 seeded random datasets match the reference exactly`, () => {
        const rnd = mulberry32(1000 + n);
        for (let i = 0; i < 150; i++) {
          const anchorDay =
            i === 0 ? MIN : i === 1 ? MAX : MIN + Math.floor(rnd() * (MAX - MIN + 1));
          const anchor = isoFromDays(anchorDay);
          const oracle = oraclePeriods(kind, anchor, n);
          const acts = randomActivities(rnd, oracle, Math.floor(rnd() * 80));
          const set = buildPeriods(kind, anchor, n);
          const got = aggregateVolume(acts.map(toVolume), set.periods);
          const want = oracleVolume(acts, oracle);
          expect(got.sports).toEqual(want.sports);
          expect(got.totals).toEqual(want.totals);
          expect(got.overall).toEqual(want.overall);
        }
      });
    }
  }

  it("counts instants at 00:00:00.000Z and 23:59:59.999Z on the boundary days in the right bucket", () => {
    const set = buildPeriods("week", "2026-11-23", 4);
    const first = set.periods[0];
    const last = set.periods[3];
    const mk = (iso: string, t: string): VolumeActivity => ({
      day: new Date(`${iso}T${t}Z`).toISOString().slice(0, 10),
      sport: "run",
      durationSeconds: 1,
      distanceMeters: 1,
    });
    const r = aggregateVolume(
      [
        mk(first?.start ?? "", "00:00:00.000"),
        mk(first?.start ?? "", "00:00:00.000"),
        mk(last?.end ?? "", "23:59:59.999"),
        mk("2026-11-30", "00:00:00.000"), // first instant after the window
        mk("2026-11-08", "23:59:59.999"), // last instant of week 1
        mk("2026-11-09", "00:00:00.000"), // first instant of week 2
        mk("2026-11-01", "23:59:59.999"), // last instant before the window (Sunday)
      ],
      set.periods,
    );
    expect(r.overall.count).toBe(5);
    expect(r.totals.map((t) => t.count)).toEqual([3, 1, 0, 1]);
    expect(first?.start).toBe("2026-11-02");
    expect(last?.end).toBe("2026-11-29");
  });

  it("keeps __proto__/constructor sports as ordinary distinct sports", () => {
    const set = buildPeriods("week", "2026-11-23", 4);
    const base = { day: "2026-11-23", durationSeconds: 10, distanceMeters: 1 };
    const r = aggregateVolume(
      [
        { ...base, sport: "__proto__" },
        { ...base, sport: " __PROTO__ " },
        { ...base, sport: "constructor" },
        { ...base, sport: "toString" },
      ],
      set.periods,
    );
    expect(r.sports.map((s) => [s.sport, s.total.count])).toEqual([
      ["__proto__", 2],
      ["constructor", 1],
      ["tostring", 1],
    ]);
    expect(Object.getPrototypeOf(r.sports[0]?.perPeriod ?? [])).toBe(Array.prototype);
  });

  it("merges case/whitespace variants but never merges subtypes or the literal 'unknown'", () => {
    const set = buildPeriods("month", "2026-11-23", 3);
    const base = { day: "2026-11-02", durationSeconds: 1, distanceMeters: null };
    const r = aggregateVolume(
      [
        { ...base, sport: "Running" },
        { ...base, sport: " running\n" },
        { ...base, sport: "trail_running" },
        { ...base, sport: null },
        { ...base, sport: "  " },
        { ...base, sport: "UNKNOWN" },
      ],
      set.periods,
    );
    const by = Object.fromEntries(r.sports.map((s) => [s.sport, s.total.count]));
    expect(by).toEqual({ running: 2, trail_running: 1, unknown: 3 });
  });

  it("sums exactly equal across sports, periods and overall for integer inputs", () => {
    const rnd = mulberry32(7);
    const set = buildPeriods("week", "2028-03-01", 12);
    const oracle = oraclePeriods("week", "2028-03-01", 12);
    const acts = randomActivities(rnd, oracle, 400).map(toVolume);
    const r = aggregateVolume(acts, set.periods);
    const field = [
      "count",
      "durationSeconds",
      "distanceMeters",
      "durationKnown",
      "distanceKnown",
    ] as const;
    for (const f of field) {
      r.totals.forEach((t, i) => {
        expect(r.sports.reduce((n, s) => n + (s.perPeriod[i]?.[f] ?? 0), 0)).toBe(t[f]);
      });
      expect(r.totals.reduce((n, t) => n + t[f], 0)).toBe(r.overall[f]);
      expect(r.sports.reduce((n, s) => n + s.total[f], 0)).toBe(r.overall[f]);
    }
    for (const t of [...r.totals, r.overall, ...r.sports.map((s) => s.total)]) {
      expect(t.durationKnown).toBeLessThanOrEqual(t.count);
      expect(t.distanceKnown).toBeLessThanOrEqual(t.count);
    }
  });

  it("is independent of input order and of duplicates being identical (float values)", () => {
    const rnd = mulberry32(31);
    const set = buildPeriods("month", "2026-11-23", 6);
    const oracle = oraclePeriods("month", "2026-11-23", 6);
    const acts = randomActivities(rnd, oracle, 300).map((a) => ({
      ...toVolume(a),
      // wildly different magnitudes make float addition order-sensitive
      durationSeconds: a.durationSeconds === null ? null : a.durationSeconds * 1e-3 + rnd() * 1e9,
      distanceMeters: a.distanceMeters === null ? null : rnd() * 1e-7 + a.distanceMeters * 1e6,
    }));
    const baseline = aggregateVolume(acts, set.periods);
    for (let k = 0; k < 20; k++) {
      const shuffled = acts
        .map((a) => ({ a, r: rnd() }))
        .sort((x, y) => x.r - y.r)
        .map((x) => x.a);
      expect(aggregateVolume(shuffled, set.periods)).toEqual(baseline);
    }
    const want = oracleVolume(
      acts.map((a) => ({ ...a, ms: Date.parse(`${a.day}T12:00:00Z`) })),
      oracle,
    );
    expect(baseline.overall.durationSeconds).toBeCloseTo(want.overall.durationSeconds, -2);
    expect(baseline.overall.count).toBe(want.overall.count);
  });

  it("handles very large counts and huge finite magnitudes without losing counts", () => {
    const set = buildPeriods("week", "2026-11-23", 4);
    const acts: VolumeActivity[] = Array.from({ length: 20_000 }, (_, i) => ({
      day: "2026-11-23",
      sport: i % 2 ? "a" : "b",
      durationSeconds: 1e15,
      distanceMeters: 0.1,
    }));
    const r = aggregateVolume(acts, set.periods);
    expect(r.overall.count).toBe(20_000);
    expect(r.overall.durationSeconds).toBe(2e19);
    expect(r.overall.distanceMeters).toBeCloseTo(2000, 6);
  });

  it("returns a complete zeroed report for no activities or no periods", () => {
    const set = buildPeriods("week", "2026-11-23", 4);
    const empty = aggregateVolume([], set.periods);
    expect(empty.sports).toEqual([]);
    expect(empty.totals).toHaveLength(4);
    expect(empty.overall.count).toBe(0);
    const none = aggregateVolume(
      [{ day: "2026-11-23", sport: "x", durationSeconds: 1, distanceMeters: 1 }],
      [],
    );
    expect(none.sports).toEqual([]);
    expect(none.overall.count).toBe(0);
  });

  it("does not mutate its inputs", () => {
    const set = buildPeriods("week", "2026-11-23", 4);
    const acts: VolumeActivity[] = [
      { day: "2026-11-24", sport: " Run ", durationSeconds: 5, distanceMeters: null },
      { day: "2026-11-23", sport: null, durationSeconds: null, distanceMeters: 5 },
    ];
    const copy = structuredClone(acts);
    aggregateVolume(acts, set.periods);
    expect(acts).toEqual(copy);
  });

  it("treats non-finite and negative values as unknown: counted, not summed", () => {
    const set = buildPeriods("week", "2026-11-23", 4);
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1];
    const r = aggregateVolume(
      [
        ...bad.map((v) => ({
          day: "2026-11-23",
          sport: "a",
          durationSeconds: v,
          distanceMeters: v,
        })),
        { day: "2026-11-23", sport: "a", durationSeconds: 5, distanceMeters: 1 },
      ],
      set.periods,
    );
    expect(r.overall).toEqual({
      count: 5,
      durationSeconds: 5,
      durationKnown: 1,
      distanceMeters: 1,
      distanceKnown: 1,
    });
  });
});

describe("computeTrend against an independent oracle", () => {
  for (const kind of KINDS) {
    it(`${kind}: deltas match the reference over 150 seeded datasets`, () => {
      const rnd = mulberry32(555 + kind.length);
      for (let i = 0; i < 150; i++) {
        const n = PERIOD_COUNTS[kind][Math.floor(rnd() * 3)] as number;
        const anchor = isoFromDays(MIN + Math.floor(rnd() * (MAX - MIN + 1)));
        const oracle = oraclePeriods(kind, anchor, n);
        const acts = randomActivities(rnd, oracle, Math.floor(rnd() * 90));
        // Make a good share of rows fully known so non-null deltas are exercised.
        const known =
          rnd() < 0.5
            ? acts.map((a) => ({
                ...a,
                durationSeconds: a.durationSeconds ?? 0,
                distanceMeters: a.distanceMeters ?? 1,
              }))
            : acts;
        const set = buildPeriods(kind, anchor, n);
        const volume = aggregateVolume(known.map(toVolume), set.periods);
        const trend = computeTrend(volume);
        const want = oracleVolume(known, oracle);
        const check = (rows: OStats[]) =>
          rows.slice(1).map((cur, j) => ({
            duration: oracleDelta(rows[j] as OStats, cur, "duration"),
            distance: oracleDelta(rows[j] as OStats, cur, "distance"),
          }));
        const strip = (pts: ReturnType<typeof computeTrend>["overall"]["points"]) =>
          pts.map((p) => ({ duration: p.duration, distance: p.distance }));
        expect(strip(trend.overall.points)).toEqual(check(want.totals));
        expect(trend.overall.points.map((p) => p.periodKey)).toEqual(
          oracle.slice(1).map((p) => p.key),
        );
        expect(trend.sports.map((s) => s.sport)).toEqual(want.sports.map((s) => s.sport));
        trend.sports.forEach((s, k) => {
          expect(strip(s.points)).toEqual(
            check((want.sports[k] as { perPeriod: OStats[] }).perPeriod),
          );
        });
        for (const s of [trend.overall, ...trend.sports]) {
          expect(s.points).toHaveLength(n - 1);
          for (const p of s.points) {
            expect(p.estimate).toBe(true);
            for (const d of [p.duration, p.distance]) {
              if (d === null) continue;
              expect(Number.isFinite(d.percent)).toBe(true);
              expect(Math.sign(d.percent)).toBe(Math.sign(d.absolute));
            }
          }
        }
      }
    });
  }

  it("recomputes the same delta from the volume report values", () => {
    const set = buildPeriods("week", "2026-11-23", 4);
    const volume = aggregateVolume(
      [
        { day: "2026-11-02", sport: "r", durationSeconds: 3000, distanceMeters: 10000 },
        { day: "2026-11-10", sport: "r", durationSeconds: 3600, distanceMeters: 9000 },
      ],
      set.periods,
    );
    const p = computeTrend(volume).overall.points[0];
    const [a, b] = [volume.totals[0], volume.totals[1]];
    expect(p?.duration).toEqual({
      absolute: (b?.durationSeconds ?? 0) - (a?.durationSeconds ?? 0),
      percent:
        (((b?.durationSeconds ?? 0) - (a?.durationSeconds ?? 0)) / (a?.durationSeconds ?? 1)) * 100,
    });
    expect(p?.duration?.percent).toBeCloseTo(20, 10);
    expect(p?.distance?.percent).toBeCloseTo(-10, 10);
  });

  it("yields no delta when the previous period is empty, zero, or partially unknown", () => {
    const set = buildPeriods("week", "2026-11-23", 4);
    const r = (acts: VolumeActivity[]) =>
      computeTrend(aggregateVolume(acts, set.periods)).overall.points;
    const d = (day: string, dur: number | null): VolumeActivity => ({
      day,
      sport: "r",
      durationSeconds: dur,
      distanceMeters: dur,
    });
    expect(r([d("2026-11-10", 100)])[0]?.duration).toBeNull(); // prev empty
    expect(r([d("2026-11-02", 0), d("2026-11-10", 100)])[0]?.duration).toBeNull(); // prev zero
    expect(
      r([d("2026-11-02", 50), d("2026-11-03", null), d("2026-11-10", 100)])[0]?.duration,
    ).toBeNull();
    expect(
      r([d("2026-11-02", 50), d("2026-11-10", 100), d("2026-11-11", null)])[0]?.duration,
    ).toBeNull();
    expect(r([d("2026-11-02", 50)])[0]?.duration).toEqual({ absolute: -50, percent: -100 }); // cur empty is fully known
  });
});

describe("aggregatePlans against an independent oracle", () => {
  const MATCH = ["manual", "none", null] as const;
  it("matches the reference over 300 seeded datasets covering every source x availability x date relation", () => {
    const rnd = mulberry32(4242);
    for (let i = 0; i < 300; i++) {
      const kind = KINDS[i % 2] as PeriodKind;
      const n = PERIOD_COUNTS[kind][Math.floor(rnd() * 3)] as number;
      const anchor = isoFromDays(MIN + Math.floor(rnd() * (MAX - MIN + 1)));
      const oracle = oraclePeriods(kind, anchor, n);
      const first = oracle[0]?.startDay ?? 0;
      const last = oracle[oracle.length - 1]?.endDay ?? 0;
      const todayNo = first + Math.floor(rnd() * (last - first + 1));
      const plans: OPlan[] = Array.from({ length: Math.floor(rnd() * 60) }, (_, k) => ({
        id: `p${k}`,
        // exact-today, day before/after today and period edges are over-sampled
        dayNo:
          ([todayNo, todayNo - 1, todayNo + 1, first, last, first - 1, last + 1][
            Math.floor(rnd() * 7)
          ] as number) + (rnd() < 0.5 ? 0 : Math.floor(rnd() * 20) - 10),
        matchSource: MATCH[Math.floor(rnd() * 3)] ?? null,
        workoutAvailable: rnd() < 0.7,
        plannedSeconds: rnd() < 0.2 ? null : Math.floor(rnd() * 6000),
      }));
      const pairs: PairInput[] = [
        ...plans
          .filter(() => rnd() < 0.5)
          .map((p) => ({
            scheduledId: p.id,
            actualSeconds: rnd() < 0.2 ? null : Math.floor(rnd() * 6000),
          })),
        { scheduledId: "ghost", actualSeconds: 1 },
        { scheduledId: "p0", actualSeconds: 7 }, // duplicate pair id; the first one seen wins
      ];
      const input: PlanInput[] = plans.map((p) => ({
        id: p.id,
        date: isoFromDays(p.dayNo),
        matchSource: p.matchSource,
        workoutAvailable: p.workoutAvailable,
        plannedSeconds: p.plannedSeconds,
      }));
      const set = buildPeriods(kind, anchor, n);
      const got = aggregatePlans(input, pairs, set.periods, isoFromDays(todayNo));
      const want = oraclePlans(plans, pairs, oracle, todayNo);
      expect(got.perPeriod).toEqual(want.perPeriod);
      expect(got.overall).toEqual(want.overall);

      const o = got.overall;
      const inside = plans.filter((p) => p.dayNo >= first && p.dayNo <= last).length;
      expect(o.due + o.upcoming + o.excludedNoMatch + o.excludedUnavailable).toBe(inside);
      expect(o.matched).toBeLessThanOrEqual(o.due);
      expect(o.time.pairsWithBoth).toBeLessThanOrEqual(o.matched);
      if (o.ratio !== null) {
        expect(o.ratio).toBeGreaterThanOrEqual(0);
        expect(o.ratio).toBeLessThanOrEqual(1);
      }
      for (const s of got.perPeriod) expect(s.matched).toBeLessThanOrEqual(s.due);
    }
  });

  const set = buildPeriods("week", "2026-11-23", 4);
  const TODAY = "2026-11-18";
  const mk = (id: string, date: string, extra: Partial<PlanInput> = {}): PlanInput => ({
    id,
    date,
    matchSource: null,
    workoutAvailable: true,
    plannedSeconds: 100,
    ...extra,
  });

  it("classifies every matchSource x availability x date relation per the approved rules", () => {
    for (const date of ["2026-11-17", TODAY, "2026-11-19"]) {
      const future = date > TODAY;
      for (const matchSource of MATCH) {
        for (const workoutAvailable of [true, false]) {
          const r = aggregatePlans(
            [mk("a", date, { matchSource, workoutAvailable })],
            [{ scheduledId: "a", actualSeconds: 90 }],
            set.periods,
            TODAY,
          ).overall;
          const label = `${date} ${matchSource} avail=${workoutAvailable}`;
          const got = {
            due: r.due,
            matched: r.matched,
            upcoming: r.upcoming,
            excludedNoMatch: r.excludedNoMatch,
            excludedUnavailable: r.excludedUnavailable,
          };
          const zero = {
            due: 0,
            matched: 0,
            upcoming: 0,
            excludedNoMatch: 0,
            excludedUnavailable: 0,
          };
          const want = future
            ? { ...zero, upcoming: 1 }
            : !workoutAvailable
              ? { ...zero, excludedUnavailable: 1 }
              : matchSource === "none"
                ? { ...zero, excludedNoMatch: 1 }
                : { ...zero, due: 1, matched: 1 };
          expect({ label, ...got }).toEqual({ label, ...want });
        }
      }
    }
  });

  it("a pair attached to an excluded or upcoming plan never counts as matched or in time totals", () => {
    const plans = [
      mk("up", "2026-11-25"),
      mk("none", "2026-11-10", { matchSource: "none" }),
      mk("gone", "2026-11-10", { workoutAvailable: false }),
    ];
    const pairs = plans.map((p) => ({ scheduledId: p.id, actualSeconds: 100 }));
    const o = aggregatePlans(plans, pairs, set.periods, TODAY).overall;
    expect(o).toMatchObject({
      due: 0,
      matched: 0,
      upcoming: 1,
      excludedNoMatch: 1,
      excludedUnavailable: 1,
      ratio: null,
    });
    expect(o.time).toEqual({
      plannedSeconds: 0,
      actualSeconds: 0,
      pairsWithBoth: 0,
      matched: 0,
      ratio: null,
    });
  });

  it("ignores unknown pair ids and plans outside the periods", () => {
    const o = aggregatePlans(
      [mk("a", "2026-11-10"), mk("out", "2025-01-01"), mk("out2", "2027-01-01")],
      [
        { scheduledId: "zzz", actualSeconds: 5 },
        { scheduledId: "out", actualSeconds: 5 },
      ],
      set.periods,
      TODAY,
    ).overall;
    expect(o).toMatchObject({ due: 1, matched: 0, upcoming: 0, ratio: 0 });
  });

  it("duplicate pair ids use the first occurrence; duplicate plan ids are counted per plan", () => {
    const o = aggregatePlans(
      [mk("a", "2026-11-10"), mk("a", "2026-11-11")],
      [
        { scheduledId: "a", actualSeconds: 30 },
        { scheduledId: "a", actualSeconds: 999 },
      ],
      set.periods,
      TODAY,
    ).overall;
    expect(o.due).toBe(2);
    expect(o.matched).toBe(2); // matched never exceeds due even with duplicate ids
    expect(o.time.actualSeconds).toBe(60);
  });

  it("time ratio needs both sides known and a non-zero planned total", () => {
    const run = (planned: number | null, actual: number | null) =>
      aggregatePlans(
        [mk("a", "2026-11-10", { plannedSeconds: planned })],
        [{ scheduledId: "a", actualSeconds: actual }],
        set.periods,
        TODAY,
      ).overall;
    expect(run(100, 150).time).toMatchObject({ ratio: 1.5, pairsWithBoth: 1 });
    expect(run(null, 150).time).toMatchObject({ ratio: null, pairsWithBoth: 0, plannedSeconds: 0 });
    expect(run(100, null).time).toMatchObject({ ratio: null, pairsWithBoth: 0, actualSeconds: 0 });
    expect(run(0, 150).time).toMatchObject({ ratio: null, pairsWithBoth: 1 });
    expect(run(100, 0).time).toMatchObject({ ratio: 0 });
    expect(run(100, null).matched).toBe(1); // still matched
  });

  it("is independent of plan and pair order", () => {
    const rnd = mulberry32(5);
    const plans = Array.from({ length: 40 }, (_, k) =>
      mk(`id${k}`, isoFromDays(daysFromCivil(2026, 10, 26) + Math.floor(rnd() * 34)), {
        plannedSeconds: rnd() * 1e6,
      }),
    );
    const pairs = plans.map((p) => ({ scheduledId: p.id, actualSeconds: rnd() * 1e6 }));
    const base = aggregatePlans(plans, pairs, set.periods, "2026-11-23");
    const shuffle = <T>(xs: T[]) =>
      xs
        .map((x) => ({ x, r: rnd() }))
        .sort((a, b) => a.r - b.r)
        .map((e) => e.x);
    for (let k = 0; k < 10; k++) {
      expect(aggregatePlans(shuffle(plans), shuffle(pairs), set.periods, "2026-11-23")).toEqual(
        base,
      );
    }
  });
});
