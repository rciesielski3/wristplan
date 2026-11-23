import { describe, expect, it } from "vitest";
import {
  aggregatePlans,
  aggregateVolume,
  computeTrend,
  type PairInput,
  type PlanInput,
  type VolumeActivity,
} from "./aggregate";
import { buildPeriods } from "./periods";

const weeks = buildPeriods("week", "2026-06-21", 4).periods; // 05-25 .. 06-21
const act = (
  day: string,
  sport: string | null,
  durationSeconds: number | null,
  distanceMeters: number | null,
): VolumeActivity => ({ day, sport, durationSeconds, distanceMeters });

describe("aggregateVolume", () => {
  it("returns empty structures for empty input", () => {
    const r = aggregateVolume([], weeks);
    expect(r.sports).toEqual([]);
    expect(r.totals).toHaveLength(4);
    expect(r.overall.count).toBe(0);
    expect(aggregateVolume([act("2026-06-01", "running", 1, 1)], []).overall.count).toBe(0);
  });

  it("buckets at week boundaries and ignores outside days", () => {
    const r = aggregateVolume(
      [
        act("2026-05-24", "running", 100, 1), // Sunday before first week
        act("2026-05-25", "running", 10, 1),
        act("2026-05-31", "running", 20, 2),
        act("2026-06-01", "running", 40, 4),
        act("2026-06-21", "running", 80, 8),
        act("2026-06-22", "running", 999, 9),
      ],
      weeks,
    );
    expect(r.totals.map((t) => t.count)).toEqual([2, 1, 0, 1]);
    expect(r.totals.map((t) => t.durationSeconds)).toEqual([30, 40, 0, 80]);
    expect(r.overall.count).toBe(4);
  });

  it("buckets months at their ends", () => {
    const months = buildPeriods("month", "2028-03-15", 3).periods;
    const r = aggregateVolume(
      [
        act("2028-01-31", "run", 1, 1),
        act("2028-02-29", "run", 2, 1),
        act("2028-03-01", "run", 4, 1),
        act("2028-03-31", "run", 8, 1),
        act("2028-04-01", "run", 16, 1),
        act("2027-12-31", "run", 32, 1),
      ],
      months,
    );
    expect(r.totals.map((t) => t.durationSeconds)).toEqual([1, 2, 12]);
  });

  it("normalizes sport names but keeps subtypes apart", () => {
    const r = aggregateVolume(
      [
        act("2026-06-01", " Running ", 10, null),
        act("2026-06-01", "RUNNING", 10, null),
        act("2026-06-01", "trail_running", 5, null),
        act("2026-06-01", null, 1, null),
        act("2026-06-01", "  ", 1, null),
        act("2026-06-01", "__proto__", 1, null),
      ],
      weeks,
    );
    expect(r.sports.map((s) => [s.sport, s.total.count])).toEqual([
      ["running", 2],
      ["trail_running", 1],
      ["unknown", 2],
      ["__proto__", 1],
    ]);
  });

  it("excludes nulls from sums but counts them, with known counts", () => {
    const r = aggregateVolume(
      [
        act("2026-06-01", "run", 60, null),
        act("2026-06-02", "run", null, 1000),
        act("2026-06-03", "run", null, null),
        act("2026-06-04", "run", 0, 0),
      ],
      weeks,
    );
    expect(r.sports[0]?.perPeriod[1]).toEqual({
      count: 4,
      durationSeconds: 60,
      distanceMeters: 1000,
      durationKnown: 2,
      distanceKnown: 2,
    });
    expect(r.overall).toEqual(r.sports[0]?.total);
  });

  it("sorts sports by duration desc then name", () => {
    const r = aggregateVolume(
      [
        act("2026-06-01", "b", 10, null),
        act("2026-06-01", "a", 10, null),
        act("2026-06-01", "z", 50, null),
        act("2026-06-01", "n", null, 5),
      ],
      weeks,
    );
    expect(r.sports.map((s) => s.sport)).toEqual(["z", "a", "b", "n"]);
  });
});

const plan = (
  id: string,
  date: string,
  matchSource: PlanInput["matchSource"] = null,
  workoutAvailable = true,
  plannedSeconds: number | null = 100,
): PlanInput => ({ id, date, matchSource, workoutAvailable, plannedSeconds });

describe("aggregatePlans", () => {
  const today = "2026-06-10";
  const period = [weeks[2]].flatMap((p) => (p ? [p] : [])); // 06-08 .. 06-14

  it("treats date === today as due and later dates as upcoming", () => {
    const r = aggregatePlans(
      [plan("a", "2026-06-09"), plan("b", "2026-06-10"), plan("c", "2026-06-11")],
      [{ scheduledId: "b", actualSeconds: 90 }],
      period,
      today,
    );
    expect(r.perPeriod[0]).toMatchObject({ due: 2, matched: 1, upcoming: 1, ratio: 0.5 });
  });

  it("counts every matchSource and availability combination", () => {
    const plans = [
      plan("1", "2026-06-08", null, true),
      plan("2", "2026-06-08", "manual", true),
      plan("3", "2026-06-08", "none", true),
      plan("4", "2026-06-08", null, false),
      plan("5", "2026-06-08", "manual", false),
      plan("6", "2026-06-08", "none", false),
    ];
    const r = aggregatePlans(plans, [{ scheduledId: "2", actualSeconds: 1 }], period, today);
    expect(r.perPeriod[0]).toMatchObject({
      due: 2,
      matched: 1,
      excludedNoMatch: 1,
      excludedUnavailable: 3,
      upcoming: 0,
    });
  });

  it("does not exclude future plans", () => {
    const r = aggregatePlans([plan("a", "2026-06-12", "none", false)], [], period, today);
    expect(r.overall).toMatchObject({ upcoming: 1, excludedNoMatch: 0, excludedUnavailable: 0 });
  });

  it("never divides by zero", () => {
    const r = aggregatePlans([plan("a", "2026-06-11")], [], period, today);
    expect(r.overall.ratio).toBeNull();
    expect(r.overall.time.ratio).toBeNull();
    expect(aggregatePlans([], [], weeks, today).overall.due).toBe(0);
  });

  it("ignores plans outside all periods and pairs for unknown or excluded plans", () => {
    const r = aggregatePlans(
      [plan("a", "2026-06-07"), plan("b", "2026-06-15"), plan("c", "2026-06-08", "none")],
      [
        { scheduledId: "a", actualSeconds: 1 },
        { scheduledId: "c", actualSeconds: 1 },
        { scheduledId: "ghost", actualSeconds: 1 },
      ],
      period,
      today,
    );
    expect(r.overall).toMatchObject({ due: 0, matched: 0, upcoming: 0, excludedNoMatch: 1 });
  });

  it("compares planned vs actual only where both are known", () => {
    const plans = [
      plan("a", "2026-06-08", null, true, 100),
      plan("b", "2026-06-08", null, true, null),
      plan("c", "2026-06-09", null, true, 300),
      plan("d", "2026-06-09", null, true, 50),
    ];
    const pairs: PairInput[] = [
      { scheduledId: "a", actualSeconds: 150 },
      { scheduledId: "b", actualSeconds: 999 },
      { scheduledId: "c", actualSeconds: null },
      { scheduledId: "d", actualSeconds: 50 },
    ];
    const t = aggregatePlans(plans, pairs, period, today).overall.time;
    expect(t).toEqual({
      plannedSeconds: 150,
      actualSeconds: 200,
      pairsWithBoth: 2,
      matched: 4,
      ratio: 200 / 150,
    });
  });

  it("returns null time ratio when planned sum is zero", () => {
    const r = aggregatePlans(
      [plan("a", "2026-06-08", null, true, 0)],
      [{ scheduledId: "a", actualSeconds: 5 }],
      period,
      today,
    );
    expect(r.overall.time).toMatchObject({ pairsWithBoth: 1, ratio: null });
  });

  it("sums overall across periods", () => {
    const r = aggregatePlans(
      [plan("a", "2026-05-26"), plan("b", "2026-06-09")],
      [{ scheduledId: "a", actualSeconds: 1 }],
      weeks,
      today,
    );
    expect(r.overall).toMatchObject({ due: 2, matched: 1, ratio: 0.5 });
    expect(r.perPeriod.map((p) => p.due)).toEqual([1, 0, 1, 0]);
  });

  it("is independent of input order", () => {
    const plans = [0.1, 0.2, 0.3, 0.7].map((s, i) => plan(`p${i}`, "2026-06-08", null, true, s));
    const pairs = plans.map((p, i) => ({ scheduledId: p.id, actualSeconds: i * 0.1 }));
    const a = aggregatePlans(plans, pairs, weeks, today);
    const b = aggregatePlans([...plans].reverse(), [...pairs].reverse(), weeks, today);
    expect(b).toEqual(a);
  });
});

describe("computeTrend", () => {
  const trend = (activities: VolumeActivity[]) => computeTrend(aggregateVolume(activities, weeks));

  it("computes absolute and percent deltas flagged as estimate", () => {
    const t = trend([act("2026-05-26", "run", 100, 1000), act("2026-06-02", "run", 150, 500)]);
    expect(t.overall.sport).toBeNull();
    expect(t.overall.points[0]).toEqual({
      periodKey: "2026-06-01",
      duration: { absolute: 50, percent: 50 },
      distance: { absolute: -500, percent: -50 },
      estimate: true,
    });
    expect(t.sports[0]?.points).toHaveLength(3);
    expect(t.sports.every((s) => s.points.every((p) => p.estimate))).toBe(true);
  });

  it("is null when the previous sum is zero", () => {
    const t = trend([act("2026-06-02", "run", 150, 500)]);
    expect(t.overall.points[0]?.duration).toBeNull();
    expect(t.overall.points[0]?.distance).toBeNull();
  });

  it("is null when either side has unknown values", () => {
    const t = trend([
      act("2026-05-26", "run", 100, 1000),
      act("2026-05-27", "run", null, null),
      act("2026-06-02", "run", 150, 500),
    ]);
    expect(t.overall.points[0]).toMatchObject({ duration: null, distance: null });
    const u = trend([
      act("2026-05-26", "run", 100, 1000),
      act("2026-06-02", "run", 150, 500),
      act("2026-06-03", "run", null, null),
    ]);
    expect(u.overall.points[0]).toMatchObject({ duration: null, distance: null });
  });

  it("reports a full drop to an empty period", () => {
    const t = trend([act("2026-05-26", "run", 100, 1000)]);
    expect(t.overall.points[0]?.duration).toEqual({ absolute: -100, percent: -100 });
  });

  it("has no points for a single period", () => {
    const one = computeTrend(aggregateVolume([], weeks.slice(0, 1)));
    expect(one.overall.points).toEqual([]);
  });
});

describe("computeTrend defensive guard", () => {
  it("is null when the previous sum is negative", () => {
    const stats = (durationSeconds: number) => ({
      count: 1,
      durationSeconds,
      distanceMeters: durationSeconds,
      durationKnown: 1,
      distanceKnown: 1,
    });
    const report = {
      periods: weeks.slice(0, 2),
      sports: [],
      totals: [stats(-10), stats(5)],
      overall: stats(-5),
    };
    expect(computeTrend(report).overall.points[0]).toMatchObject({
      duration: null,
      distance: null,
    });
  });
});
