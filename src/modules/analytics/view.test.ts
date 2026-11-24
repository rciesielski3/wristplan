import { describe, expect, it } from "vitest";
import { aggregatePlans, aggregateVolume, computeTrend } from "./aggregate";
import type { DashboardData } from "./load";
import { buildPeriods } from "./periods";
import {
  buildDashboardView,
  buildKpiTiles,
  dashboardHref,
  ESTIMATE_LABEL,
  navTargets,
  parseDashboardQuery,
  planCells,
  sportLabel,
  volumeCell,
} from "./view";

const stats = (count: number, dur: number, dist: number, dk = count, sk = count) => ({
  count,
  durationSeconds: dur,
  distanceMeters: dist,
  durationKnown: dk,
  distanceKnown: sk,
});

describe("sportLabel", () => {
  it.each([
    ["running", "Running"],
    ["strength_training", "Strength training"],
    ["unknown", "Unknown"],
    ["kayaking", "kayaking"],
    ["<b>x</b>", "<b>x</b>"],
    ["constructor", "constructor"],
    ["__proto__", "__proto__"],
  ])("%s -> %s", (key, label) => {
    expect(sportLabel(key)).toBe(label);
  });
});

describe("volumeCell", () => {
  it("is 0 for an empty cell", () => {
    expect(volumeCell(stats(0, 0, 0))).toBe("0");
  });
  it("joins count, duration and distance", () => {
    expect(volumeCell(stats(2, 3725, 20500))).toBe("2 · 1:02:05 · 20.50 km");
  });
  it("shows n of m for unknown durations and distances", () => {
    expect(volumeCell(stats(2, 600, 0, 1, 0))).toBe("2 · 10:00 (1 of 2) · — (0 of 2)");
  });
});

describe("planCells", () => {
  const base = {
    due: 4,
    matched: 3,
    upcoming: 1,
    excludedNoMatch: 2,
    excludedUnavailable: 5,
    ratio: 0.75,
  };
  it("formats counts and the matched-pair comparison", () => {
    const cells = planCells({
      ...base,
      time: { plannedSeconds: 1200, actualSeconds: 1800, pairsWithBoth: 2, matched: 3, ratio: 1.5 },
    });
    expect(cells).toEqual({
      completed: "3 of 4 (75%)",
      upcoming: "1",
      excludedNoMatch: "2",
      excludedUnavailable: "5",
      time: "30:00 actual vs 20:00 planned (150%) over 2 of 3 matched pairs",
    });
  });
  it("shows the empty marker without comparable pairs or due plans", () => {
    const cells = planCells({
      ...base,
      due: 0,
      matched: 0,
      ratio: null,
      time: { plannedSeconds: 0, actualSeconds: 0, pairsWithBoth: 0, matched: 0, ratio: null },
    });
    expect(cells.completed).toBe("—");
    expect(cells.time).toBe("—");
  });
});

describe("parseDashboardQuery", () => {
  it("falls back to defaults for junk", () => {
    expect(parseDashboardQuery("bogus", "x")).toEqual({ kind: "week", count: 8 });
    expect(parseDashboardQuery(undefined, undefined)).toEqual({ kind: "week", count: 8 });
    expect(parseDashboardQuery("month", "7")).toEqual({ kind: "month", count: 6 });
  });
  it("takes the first array value and validates the count per kind", () => {
    expect(parseDashboardQuery(["month", "week"], ["12", "3"])).toEqual({
      kind: "month",
      count: 12,
    });
    expect(parseDashboardQuery("week", "3")).toEqual({ kind: "week", count: 8 });
    expect(parseDashboardQuery("week", "4")).toEqual({ kind: "week", count: 4 });
  });
});

describe("navTargets", () => {
  it("shifts by the same count", () => {
    expect(navTargets("week", "2026-06-17", 4)).toEqual({ prev: "2026-05-20", next: "2026-07-15" });
    expect(navTargets("month", "2026-06-17", 3)).toEqual({
      prev: "2026-03-01",
      next: "2026-09-01",
    });
  });
  it("disables prev before 1970-01-01 and next after 2100-12-31", () => {
    expect(navTargets("week", "1970-01-01", 4).prev).toBeNull();
    expect(navTargets("week", "1970-01-01", 4).next).not.toBeNull();
    expect(navTargets("week", "2100-12-31", 4).next).toBeNull();
    expect(navTargets("week", "2100-12-31", 4).prev).not.toBeNull();
    expect(navTargets("month", "1970-02-10", 3).prev).toBeNull();
    expect(navTargets("month", "2100-11-10", 3).next).toBeNull();
    expect(navTargets("month", "2100-11-10", 3).prev).toBe("2100-08-01");
  });
  it("allows a target exactly on the range edges", () => {
    expect(navTargets("week", "1970-01-29", 4).prev).toBe("1970-01-01");
    expect(navTargets("week", "2100-12-03", 4).next).toBe("2100-12-31");
  });
  it("returns null instead of throwing on a malformed anchor", () => {
    expect(navTargets("week", "garbage", 4)).toEqual({ prev: null, next: null });
  });
});

describe("dashboardHref", () => {
  it("builds links with and without a date", () => {
    expect(dashboardHref("week", 4)).toBe("/dashboard?period=week&n=4");
    expect(dashboardHref("month", 6, "2026-06-01")).toBe(
      "/dashboard?period=month&n=6&date=2026-06-01",
    );
  });
});

function data(
  kind: "week" | "month",
  count: number,
  anchor: string,
  overrides: Partial<DashboardData> = {},
  acts: Parameters<typeof aggregateVolume>[0] = [],
): DashboardData {
  const periodSet = buildPeriods(kind, anchor, count);
  const volume = aggregateVolume(acts, periodSet.periods);
  return {
    periodSet,
    volume,
    plans: aggregatePlans([], [], periodSet.periods, anchor),
    trend: computeTrend(volume),
    notices: [],
    lastSync: null,
    activityCount: acts.length,
    planCount: 0,
    partial: false,
    ...overrides,
  };
}

describe("buildDashboardView", () => {
  const anchor = "2026-06-17";
  const acts = [
    { day: "2026-06-16", sport: "running", durationSeconds: 600, distanceMeters: 2000 },
    { day: "2026-06-16", sport: "kayak", durationSeconds: null, distanceMeters: null },
  ];

  it("shapes an empty range", () => {
    const v = buildDashboardView(data("week", 4, anchor), { kind: "week", count: 4 }, anchor);
    expect(v.volume).toEqual({ empty: true, rows: [], hasUnknown: false });
    expect(v.lastSync).toBe("never");
    expect(v.periodLabels).toHaveLength(4);
    expect(v.trend?.columns).toHaveLength(3);
    expect(v.plans?.rows).toHaveLength(5);
  });

  it.each([
    ["week", "week"],
    ["month", "month"],
  ] as const)("exposes the %s unit and formed trend captions", (kind, unit) => {
    const q = { kind, count: 3 };
    const v = buildDashboardView(data(kind, 3, anchor), q, anchor);
    expect(v.unit).toBe(unit);
    expect(v.trend?.metrics).toEqual([
      {
        metric: "duration",
        title: "Duration",
        caption: `Duration change versus the previous ${unit} per sport. ${ESTIMATE_LABEL}`,
      },
      {
        metric: "distance",
        title: "Distance",
        caption: `Distance change versus the previous ${unit} per sport. ${ESTIMATE_LABEL}`,
      },
    ]);
    expect(ESTIMATE_LABEL).toBe("Estimate: calculated from stored activities, not a Garmin metric");
  });

  it("shapes sports, total row, labels and unknown-value flag", () => {
    const v = buildDashboardView(
      data("week", 4, anchor, { lastSync: "ok" }, acts),
      { kind: "week", count: 4 },
      anchor,
    );
    expect(v.volume.rows.map((r) => r.label)).toEqual(["Running", "kayak", "Total"]);
    expect(v.volume.rows[0]?.cells).toHaveLength(4);
    expect(v.volume.rows[2]?.total).toBe("2 · 10:00 (1 of 2) · 2.00 km (1 of 2)");
    expect(v.volume.hasUnknown).toBe(true);
    expect(v.lastSync).toBe("ok");
    expect(v.trend?.duration.map((r) => r.label)).toEqual(["Overall", "Running", "kayak"]);
  });

  it("does not flag unknowns when every value is known", () => {
    const v = buildDashboardView(
      data("week", 4, anchor, {}, [acts[0] ?? ({} as never)]),
      { kind: "week", count: 4 },
      anchor,
    );
    expect(v.volume.hasUnknown).toBe(false);
  });

  it("nulls plans and trend, passing notices through", () => {
    const v = buildDashboardView(
      data("month", 3, anchor, { plans: null, trend: null, notices: ["n1"] }),
      { kind: "month", count: 3 },
      anchor,
    );
    expect(v.plans).toBeNull();
    expect(v.trend).toBeNull();
    expect(v.notices).toEqual(["n1"]);
  });

  it("keeps the same count in every link and marks the active kind and count", () => {
    const v = buildDashboardView(data("week", 4, anchor), { kind: "week", count: 4 }, anchor);
    expect(v.nav.latest).toBe("/dashboard?period=week&n=4");
    expect(v.nav.prev).toBe("/dashboard?period=week&n=4&date=2026-05-20");
    expect(v.nav.next).toBe("/dashboard?period=week&n=4&date=2026-07-15");
    expect(v.nav.kinds).toEqual([
      { label: "Week", href: "/dashboard?period=week&n=8&date=2026-06-17", current: true },
      { label: "Month", href: "/dashboard?period=month&n=6&date=2026-06-17", current: false },
    ]);
    expect(v.nav.counts.map((c) => [c.label, c.current])).toEqual([
      ["4 weeks", true],
      ["8 weeks", false],
      ["12 weeks", false],
    ]);
    const m = buildDashboardView(data("month", 3, anchor), { kind: "month", count: 3 }, anchor);
    expect(m.nav.counts.map((c) => c.label)).toEqual(["3 months", "6 months", "12 months"]);
  });

  it("drops the prev link at the lower range edge", () => {
    const v = buildDashboardView(
      data("week", 4, "1970-01-01"),
      { kind: "week", count: 4 },
      "1970-01-01",
    );
    expect(v.nav.prev).toBeNull();
    expect(v.nav.next).not.toBeNull();
  });
});

describe("buildKpiTiles", () => {
  const stats = (count: number, durationKnown: number, distanceKnown: number) => ({
    count,
    durationSeconds: 5400,
    distanceMeters: 12500,
    durationKnown,
    distanceKnown,
  });
  const tiles = (overall: ReturnType<typeof stats>) =>
    buildKpiTiles({ volume: { overall } } as unknown as DashboardData);

  it("formats totals with the shared helpers", () => {
    expect(tiles(stats(2, 2, 2))).toEqual([
      { label: "Activities", value: "2" },
      { label: "Duration", value: "1:30:00" },
      { label: "Distance", value: "12.50 km" },
    ]);
  });

  it("notes partially known values", () => {
    expect(tiles(stats(3, 2, 0)).map((t) => t.value)).toEqual([
      "3",
      "1:30:00 (2 of 3)",
      "— (0 of 3)",
    ]);
  });
});
