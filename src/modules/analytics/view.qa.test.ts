import { describe, expect, it } from "vitest";
import { MAX_ANCHOR, MIN_ANCHOR, parseAnchor } from "../calendar/grid";
import {
  aggregatePlans,
  aggregateVolume,
  computeTrend,
  type PlanInput,
  type VolumeActivity,
} from "./aggregate";
import type { DashboardData } from "./load";
import {
  buildPeriods,
  DEFAULT_PERIOD_COUNT,
  PERIOD_COUNTS,
  type PeriodKind,
  parsePeriodCount,
  parsePeriodKind,
} from "./periods";
import {
  buildDashboardView,
  dashboardHref,
  ESTIMATE_LABEL,
  navTargets,
  parseDashboardQuery,
  planCells,
  sportLabel,
  volumeCell,
} from "./view";

const KINDS: readonly PeriodKind[] = ["week", "month"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const stats = (count: number, dur: number, dist: number, dk = count, sk = count) => ({
  count,
  durationSeconds: dur,
  distanceMeters: dist,
  durationKnown: dk,
  distanceKnown: sk,
});

const BAD_TOKENS = /NaN|undefined|Infinity|\[object|null/;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value !== null && typeof value === "object")
    for (const v of Object.values(value)) strings(v, out);
  return out;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build(
  kind: PeriodKind,
  count: number,
  anchor: string,
  acts: readonly VolumeActivity[] = [],
  plans: readonly PlanInput[] = [],
  overrides: Partial<DashboardData> = {},
): DashboardData {
  const periodSet = buildPeriods(kind, anchor, count);
  const volume = aggregateVolume(acts, periodSet.periods);
  return {
    periodSet,
    volume,
    plans: aggregatePlans(plans, [], periodSet.periods, anchor),
    trend: computeTrend(volume),
    notices: [],
    lastSync: null,
    activityCount: acts.length,
    planCount: plans.length,
    partial: false,
    ...overrides,
  };
}

describe("sportLabel (adversarial)", () => {
  it.each([
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
    "__defineGetter__",
    "prototype",
  ])("returns the key itself for the inherited name %s", (key) => {
    expect(sportLabel(key)).toBe(key);
    expect(typeof sportLabel(key)).toBe("string");
  });

  it("matches known keys exactly: no trimming, no case folding", () => {
    expect(sportLabel(" running")).toBe(" running");
    expect(sportLabel("running ")).toBe("running ");
    expect(sportLabel("RUNNING")).toBe("RUNNING");
    expect(sportLabel("Running")).toBe("Running");
    expect(sportLabel("")).toBe("");
    expect(sportLabel("\t\n")).toBe("\t\n");
  });

  it("passes unicode and very long strings through unchanged", () => {
    for (const s of ["Läufer", "走る", "🏃‍♀️", "é", "a".repeat(100_000)]) {
      expect(sportLabel(s)).toBe(s);
    }
  });

  it("keeps HTML-significant characters raw (escaping is React's job)", () => {
    for (const s of ["<script>alert(1)</script>", "a&amp;b", '"quoted"', "it's", "<img src=x>"]) {
      expect(sportLabel(s)).toBe(s);
    }
  });

  it("keeps raw markup raw in the view model rows and trend labels", () => {
    const key = "<script>alert(1)</script>";
    const v = buildDashboardView(
      build("week", 4, "2026-06-17", [
        { day: "2026-06-16", sport: key, durationSeconds: 60, distanceMeters: 1 },
      ]),
      { kind: "week", count: 4 },
      "2026-06-17",
    );
    expect(v.volume.rows[0]?.label).toBe(key);
    expect(v.trend?.duration[1]?.label).toBe(key);
  });
});

describe("volumeCell (adversarial)", () => {
  it("covers every known-count combination for count 3", () => {
    for (let dk = 0; dk <= 3; dk++) {
      for (let sk = 0; sk <= 3; sk++) {
        const cell = volumeCell(stats(3, 120, 3000, dk, sk));
        const dur = dk < 3 ? `${dk === 0 ? "—" : "2:00"} (${dk} of 3)` : "2:00";
        const dist = sk < 3 ? `${sk === 0 ? "—" : "3.00 km"} (${sk} of 3)` : "3.00 km";
        expect(cell).toBe(`3 · ${dur} · ${dist}`);
      }
    }
  });

  it("handles zero known durations with a known distance and the reverse", () => {
    expect(volumeCell(stats(2, 0, 5000, 0, 2))).toBe("2 · — (0 of 2) · 5.00 km");
    expect(volumeCell(stats(2, 600, 0, 2, 0))).toBe("2 · 10:00 · — (0 of 2)");
  });

  it("does not annotate a single fully known activity", () => {
    expect(volumeCell(stats(1, 59, 999))).toBe("1 · 0:59 · 1.00 km");
  });

  it("handles huge and fractional values without exponent noise or NaN", () => {
    const huge = volumeCell(stats(1, 1e9, 1e12));
    expect(huge).toBe("1 · 277777:46:40 · 1000000000.00 km");
    expect(volumeCell(stats(1, 0.4, 0.4))).toBe("1 · 0:00 · 0.00 km");
    expect(volumeCell(stats(1, 59.5, 5))).toBe("1 · 1:00 · 0.01 km");
    expect(volumeCell(stats(1, 3599.6, 12.345))).toBe("1 · 1:00:00 · 0.01 km");
    expect(huge).not.toMatch(BAD_TOKENS);
  });

  it("treats count 0 as a bare 0 even when sums are non-zero (defensive)", () => {
    expect(volumeCell(stats(0, 99, 99, 0, 0))).toBe("0");
  });
});

describe("planCells (adversarial)", () => {
  const base = { due: 0, matched: 0, upcoming: 0, excludedNoMatch: 0, excludedUnavailable: 0 };
  const none = { plannedSeconds: 0, actualSeconds: 0, pairsWithBoth: 0, matched: 0, ratio: null };

  it("shows the missing marker for zero denominators, never NaN or Infinity", () => {
    const c = planCells({ ...base, ratio: null, time: none });
    expect(c).toEqual({
      completed: "—",
      upcoming: "0",
      excludedNoMatch: "0",
      excludedUnavailable: "0",
      time: "—",
    });
  });

  it("renders ratios above 100% and a 0% completion", () => {
    expect(
      planCells({
        ...base,
        due: 2,
        matched: 0,
        ratio: 0,
        time: { plannedSeconds: 60, actualSeconds: 600, pairsWithBoth: 1, matched: 1, ratio: 10 },
      }),
    ).toMatchObject({
      completed: "0 of 2 (0%)",
      time: "10:00 actual vs 1:00 planned (1000%) over 1 of 1 matched pairs",
    });
  });

  it("renders a null ratio with the marker instead of NaN when planned time is zero", () => {
    const c = planCells({
      ...base,
      due: 1,
      matched: 1,
      ratio: 1,
      time: { plannedSeconds: 0, actualSeconds: 600, pairsWithBoth: 1, matched: 1, ratio: null },
    });
    expect(c.time).toBe("10:00 actual vs 0:00 planned over 1 of 1 matched pairs");
  });

  it("uses the marker for time when no pair has both durations even if pairs matched", () => {
    expect(
      planCells({
        ...base,
        due: 3,
        matched: 3,
        ratio: 1,
        time: { ...none, matched: 3 },
      }).time,
    ).toBe("—");
  });
});

describe("navTargets at every range edge", () => {
  const stepDays = (n: number) => 7 * n;
  const addDay = (day: string, d: number) =>
    new Date(Date.parse(`${day}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

  for (const n of PERIOD_COUNTS.week) {
    it(`week x${n}: prev is allowed exactly on ${MIN_ANCHOR} and null one day earlier`, () => {
      expect(navTargets("week", addDay(MIN_ANCHOR, stepDays(n)), n).prev).toBe(MIN_ANCHOR);
      expect(navTargets("week", addDay(MIN_ANCHOR, stepDays(n) - 1), n).prev).toBeNull();
      expect(navTargets("week", addDay(MIN_ANCHOR, stepDays(n) + 1), n).prev).toBe("1970-01-02");
      expect(navTargets("week", MIN_ANCHOR, n).prev).toBeNull();
    });
    it(`week x${n}: next is allowed exactly on ${MAX_ANCHOR} and null one day later`, () => {
      expect(navTargets("week", addDay(MAX_ANCHOR, -stepDays(n)), n).next).toBe(MAX_ANCHOR);
      expect(navTargets("week", addDay(MAX_ANCHOR, -stepDays(n) + 1), n).next).toBeNull();
      expect(navTargets("week", addDay(MAX_ANCHOR, -stepDays(n) - 1), n).next).toBe("2100-12-30");
      expect(navTargets("week", MAX_ANCHOR, n).next).toBeNull();
    });
  }

  for (const n of PERIOD_COUNTS.month) {
    it(`month x${n}: prev lands on the first of a month; null once before 1970-01`, () => {
      const at = (m: number, day: string) => {
        const y = 1970 + Math.floor(m / 12);
        return `${y}-${String((m % 12) + 1).padStart(2, "0")}-${day}`;
      };
      expect(navTargets("month", at(n, "15"), n).prev).toBe("1970-01-01");
      expect(navTargets("month", at(n, "01"), n).prev).toBe("1970-01-01");
      expect(navTargets("month", at(n - 1, "28"), n).prev).toBeNull();
      expect(navTargets("month", at(n + 1, "10"), n).prev).toBe("1970-02-01");
    });
    it(`month x${n}: next is null once after 2100-12`, () => {
      const ym = (back: number) => {
        const m = 2100 * 12 + 11 - back;
        return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;
      };
      const lastOk = `${ym(n)}-28`;
      const tooLate = `${ym(n - 1)}-01`;
      expect(navTargets("month", lastOk, n).next).toBe("2100-12-01");
      expect(navTargets("month", tooLate, n).next).toBeNull();
    });
  }

  it("never returns a value outside the range or a non YYYY-MM-DD string, at any nearby anchor", () => {
    const anchors: string[] = [];
    for (let d = -120; d <= 120; d++) {
      anchors.push(addDay(MIN_ANCHOR, d), addDay(MAX_ANCHOR, d));
    }
    for (const kind of KINDS) {
      for (const n of PERIOD_COUNTS[kind]) {
        for (const anchor of anchors) {
          const t = navTargets(kind, anchor, n);
          for (const v of [t.prev, t.next]) {
            if (v === null) continue;
            expect(v).toMatch(DAY_RE);
            expect(v >= MIN_ANCHOR && v <= MAX_ANCHOR).toBe(true);
          }
        }
      }
    }
  });

  it("handles anchors beyond the range without throwing", () => {
    expect(() => navTargets("week", "1969-12-31", 4)).not.toThrow();
    expect(() => navTargets("month", "2101-01-01", 3)).not.toThrow();
    expect(navTargets("week", "1969-12-31", 4).prev).toBeNull();
    expect(navTargets("month", "2101-01-01", 3).next).toBeNull();
    expect(navTargets("week", "0001-01-01", 4).prev).toBeNull();
    expect(navTargets("week", "9999-12-31", 4).next).toBeNull();
  });

  it.each([
    "",
    "garbage",
    "2026-13-01",
    "2026-02-30",
    "2026-6-1",
    "２０２６-06-17",
    "2026-06-17T00:00:00Z",
    "__proto__",
    " 2026-06-17",
  ])("returns null/null for the malformed anchor %j (week)", (anchor) => {
    expect(navTargets("week", anchor, 8)).toEqual({ prev: null, next: null });
  });

  it.each(["", "garbage", "2026-6-1", "２０２６-06-17", "__proto__", " 2026-06-17"])(
    "returns null/null for the malformed anchor %j (month)",
    (anchor) => {
      expect(navTargets("month", anchor, 6)).toEqual({ prev: null, next: null });
    },
  );

  it.each(["2026-13-01", "2026-02-30", "2026-06-17T00:00:00Z"])(
    "returns null/null for the malformed anchor %j (month)",
    (anchor) => {
      expect(navTargets("month", anchor, 6)).toEqual({ prev: null, next: null });
    },
  );

  it("falls back to the default count when handed an unsupported count", () => {
    expect(navTargets("week", "2026-06-17", 5)).toEqual(navTargets("week", "2026-06-17", 8));
    expect(navTargets("month", "2026-06-17", Number.NaN)).toEqual(
      navTargets("month", "2026-06-17", 6),
    );
  });
});

describe("parseDashboardQuery (adversarial)", () => {
  const WEEK = { kind: "week", count: 8 };

  it("falls back to defaults for empty arrays, empty strings and undefined", () => {
    expect(parseDashboardQuery([], [])).toEqual(WEEK);
    expect(parseDashboardQuery("", "")).toEqual(WEEK);
    expect(parseDashboardQuery([""], [""])).toEqual(WEEK);
    expect(parseDashboardQuery(undefined, undefined)).toEqual(WEEK);
  });

  it("uses only the first duplicate for both parameters", () => {
    expect(parseDashboardQuery(["month", "week"], ["12", "4"])).toEqual({
      kind: "month",
      count: 12,
    });
    expect(parseDashboardQuery(["bogus", "month"], ["12", "4"])).toEqual({
      kind: "week",
      count: 12,
    });
    expect(parseDashboardQuery(["week"], ["x", "4"])).toEqual(WEEK);
  });

  it("validates the count against the parsed kind, not the raw string", () => {
    expect(parseDashboardQuery("month", "4")).toEqual({ kind: "month", count: 6 });
    expect(parseDashboardQuery("week", "6")).toEqual({ kind: "week", count: 8 });
    expect(parseDashboardQuery("bogus", "3")).toEqual({ kind: "week", count: 8 });
  });

  it.each([
    "08",
    " 8",
    "8 ",
    "8.0",
    "+8",
    "-8",
    "1e1",
    "0x8",
    "８",
    "٨",
    "9".repeat(400),
    "99999999999999999999",
    "__proto__",
    "constructor",
    "toString",
    "🏃",
    "8\n",
    "Infinity",
    "NaN",
  ])("rejects the non-canonical count %j", (n) => {
    expect(parseDashboardQuery("week", n).count).toBe(8);
    expect(parseDashboardQuery("month", n).count).toBe(6);
  });

  it.each([
    "__proto__",
    "constructor",
    "WEEK",
    "Week",
    " week",
    "week ",
    "mönth",
    "🏃",
    "week".repeat(10_000),
  ])("rejects the non-canonical kind %j", (p) => {
    expect(parseDashboardQuery(p, "12")).toEqual({ kind: "week", count: 12 });
  });

  it("accepts every allowed combination", () => {
    for (const kind of KINDS) {
      for (const n of PERIOD_COUNTS[kind]) {
        expect(parseDashboardQuery(kind, String(n))).toEqual({ kind, count: n });
      }
    }
  });

  it("returns a plain object and does not pollute prototypes", () => {
    parseDashboardQuery("__proto__", "__proto__");
    expect(({} as Record<string, unknown>).kind).toBeUndefined();
    expect(Object.keys(parseDashboardQuery("x", "y"))).toEqual(["kind", "count"]);
  });
});

describe("dashboardHref round-trip", () => {
  it("survives URL parsing back to the same kind, count and anchor", () => {
    for (const kind of KINDS) {
      for (const n of PERIOD_COUNTS[kind]) {
        for (const date of ["2026-06-17", MIN_ANCHOR, MAX_ANCHOR]) {
          const url = new URL(dashboardHref(kind, n, date), "http://localhost");
          expect(url.pathname).toBe("/dashboard");
          expect(
            parseDashboardQuery(
              url.searchParams.get("period") ?? undefined,
              url.searchParams.get("n") ?? undefined,
            ),
          ).toEqual({ kind, count: n });
          expect(parseAnchor(url.searchParams.get("date") ?? undefined, "2000-01-01")).toBe(date);
          expect([...url.searchParams.keys()]).toEqual(["period", "n", "date"]);
        }
      }
    }
  });

  it("omits date for the latest link and falls back to today on parse", () => {
    const url = new URL(dashboardHref("month", 12), "http://localhost");
    expect(url.searchParams.has("date")).toBe(false);
    expect(parseAnchor(url.searchParams.get("date") ?? undefined, "2026-11-23")).toBe("2026-11-23");
  });

  it("emits only characters that need no URL encoding", () => {
    for (const kind of KINDS) {
      for (const n of PERIOD_COUNTS[kind]) {
        const href = dashboardHref(kind, n, "2026-06-17");
        expect(encodeURI(href)).toBe(href);
      }
    }
  });
});

describe("single parsed query drives every link", () => {
  const anchor = "2026-06-17";
  const raws: [string | string[] | undefined, string | string[] | undefined][] = [
    ["week", "7"],
    ["month", "7"],
    ["week", "04"],
    ["month", ["12", "3"]],
    [["month", "week"], "99"],
    ["bogus", "12"],
    [undefined, undefined],
    ["week", "4"],
    ["month", "3"],
  ];

  it.each(raws)("period=%j n=%j", (period, n) => {
    const query = parseDashboardQuery(period, n);
    // The page never hands raw input to the view builder, so this is the same source of truth.
    expect(query.count).toBe(parsePeriodCount(parsePeriodKind(query.kind), String(query.count)));
    const v = buildDashboardView(build(query.kind, query.count, anchor), query, anchor);
    expect(v.periodLabels).toHaveLength(query.count);

    const sameCount = [v.nav.prev, v.nav.next, v.nav.latest].filter((h): h is string => h !== null);
    expect(sameCount).toHaveLength(3);
    for (const href of sameCount) {
      expect(href).toContain(`period=${query.kind}&n=${query.count}`);
    }
    for (const c of v.nav.counts) {
      expect(c.href).toContain(`period=${query.kind}&n=`);
      expect(c.href).toContain(`&date=${anchor}`);
    }
    expect(v.nav.counts.filter((c) => c.current)).toHaveLength(1);
    expect(v.nav.kinds.filter((k) => k.current)).toHaveLength(1);
    expect(v.nav.kinds.find((k) => k.current)?.href).toContain(
      `period=${query.kind}&n=${DEFAULT_PERIOD_COUNT[query.kind]}`,
    );
    // the raw, unsupported value must never leak into a link when it was rejected
    if (typeof n === "string" && ["7", "04", "99"].includes(n)) {
      for (const href of [...sameCount, ...v.nav.counts.map((c) => c.href)]) {
        expect(href).not.toContain(`n=${n}&`);
        expect(href.endsWith(`n=${n}`)).toBe(false);
      }
    }
  });

  it("toggling kind switches to that kind's default count, from every count", () => {
    for (const kind of KINDS) {
      for (const n of PERIOD_COUNTS[kind]) {
        const v = buildDashboardView(build(kind, n, anchor), { kind, count: n }, anchor);
        const week = v.nav.kinds.find((k) => k.label === "Week");
        const month = v.nav.kinds.find((k) => k.label === "Month");
        expect(week?.href).toBe(`/dashboard?period=week&n=8&date=${anchor}`);
        expect(month?.href).toBe(`/dashboard?period=month&n=6&date=${anchor}`);
        expect(v.nav.kinds.map((k) => k.current)).toEqual(
          kind === "week" ? [true, false] : [false, true],
        );
      }
    }
  });

  it("count links cover exactly the allowed counts for the kind, in order", () => {
    for (const kind of KINDS) {
      const count = PERIOD_COUNTS[kind][0] ?? 0;
      const v = buildDashboardView(build(kind, count, anchor), { kind, count }, anchor);
      expect(v.nav.counts.map((c) => c.href)).toEqual(
        PERIOD_COUNTS[kind].map((n) => dashboardHref(kind, n, anchor)),
      );
    }
  });
});

describe("buildDashboardView states", () => {
  const anchor = "2026-06-17";

  it("renders an empty state with no rows and no unknown flag", () => {
    const v = buildDashboardView(build("month", 3, anchor), { kind: "month", count: 3 }, anchor);
    expect(v.volume).toEqual({ empty: true, rows: [], hasUnknown: false });
    expect(v.lastSync).toBe("never");
    expect(v.plans?.rows.map((r) => r.completed)).toEqual(["—", "—", "—", "—"]);
    expect(v.trend?.duration).toHaveLength(1);
    expect(v.trend?.duration[0]).toEqual({ label: "Overall", cells: ["—", "—"] });
  });

  it("reports null plans and null trend independently", () => {
    const q = { kind: "week", count: 4 } as const;
    const a = buildDashboardView(build("week", 4, anchor, [], [], { plans: null }), q, anchor);
    expect(a.plans).toBeNull();
    expect(a.trend).not.toBeNull();
    const b = buildDashboardView(build("week", 4, anchor, [], [], { trend: null }), q, anchor);
    expect(b.trend).toBeNull();
    expect(b.plans).not.toBeNull();
    const c = buildDashboardView(
      build("week", 4, anchor, [], [], { trend: null, plans: null, notices: ["x", "y"] }),
      q,
      anchor,
    );
    expect([c.plans, c.trend, c.notices]).toEqual([null, null, ["x", "y"]]);
  });

  it("keeps the estimate label constant and mentions it is not a Garmin metric", () => {
    expect(ESTIMATE_LABEL).toBe("Estimate: calculated from stored activities, not a Garmin metric");
  });

  it("passes the last sync text through untouched", () => {
    const v = buildDashboardView(
      build("week", 4, anchor, [], [], { lastSync: "ok (x), 1 imported" }),
      { kind: "week", count: 4 },
      anchor,
    );
    expect(v.lastSync).toBe("ok (x), 1 imported");
  });

  it("builds rows without crashing at the range edges for every kind and count", () => {
    for (const kind of KINDS) {
      for (const n of PERIOD_COUNTS[kind]) {
        for (const a of [MIN_ANCHOR, MAX_ANCHOR]) {
          const v = buildDashboardView(build(kind, n, a), { kind, count: n }, a);
          expect(v.periodLabels).toHaveLength(n);
          for (const s of strings(v)) expect(s).not.toMatch(BAD_TOKENS);
        }
      }
    }
  });

  it("is deterministic and does not mutate its input", () => {
    const acts: VolumeActivity[] = [
      { day: "2026-06-16", sport: "running", durationSeconds: 600, distanceMeters: 2000 },
      { day: "2026-06-10", sport: "cycling", durationSeconds: null, distanceMeters: 5 },
    ];
    const d = build("week", 4, anchor, acts);
    const before = JSON.stringify(d);
    const q = { kind: "week", count: 4 } as const;
    const one = buildDashboardView(d, q, anchor);
    const two = buildDashboardView(d, q, anchor);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(two).toEqual(one);
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe("buildDashboardView never renders NaN/undefined/Infinity (seeded fuzz)", () => {
  const SPORTS = [
    "running",
    "cycling",
    "walking",
    "hiking",
    "strength_training",
    "mobility",
    "other",
    "kayaking",
    "<b>x</b>",
    "constructor",
    "__proto__",
    "toString",
    "  Run  ",
    "ünï😀",
    "",
    null,
  ];
  const NUMBERS: (number | null)[] = [
    null,
    null,
    0,
    0.4,
    1,
    59.5,
    600,
    3725.5,
    86_400,
    1e9,
    1e12,
    -5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
  ];
  const ANCHORS = [
    "1970-01-01",
    "1970-01-05",
    "2026-06-17",
    "2026-02-28",
    "2100-12-31",
    "2100-12-01",
  ];

  it("scans the whole view model over many random inputs", () => {
    const rand = mulberry32(20261123);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    for (let i = 0; i < 300; i++) {
      const kind = pick(KINDS);
      const count = pick(PERIOD_COUNTS[kind]);
      const anchor = pick(ANCHORS);
      const set = buildPeriods(kind, anchor, count);
      const first = set.periods[0]?.start ?? anchor;
      const acts: VolumeActivity[] = Array.from({ length: Math.floor(rand() * 40) }, () => {
        const offset = Math.floor(rand() * count * (kind === "week" ? 7 : 31));
        const day = new Date(Date.parse(`${first}T00:00:00Z`) + offset * 86_400_000)
          .toISOString()
          .slice(0, 10);
        return {
          day,
          sport: pick(SPORTS),
          durationSeconds: pick(NUMBERS),
          distanceMeters: pick(NUMBERS),
        };
      });
      const plans: PlanInput[] = Array.from({ length: Math.floor(rand() * 15) }, (_, j) => ({
        id: `p${j}`,
        date: new Date(
          Date.parse(`${first}T00:00:00Z`) + Math.floor(rand() * count * 7) * 86_400_000,
        )
          .toISOString()
          .slice(0, 10),
        matchSource: pick(["manual", "none", null] as const),
        workoutAvailable: rand() > 0.2,
        plannedSeconds: pick(NUMBERS.filter((n) => n === null || (Number.isFinite(n) && n >= 0))),
      }));
      const pairs = plans
        .filter(() => rand() > 0.4)
        .map((p) => ({
          scheduledId: p.id,
          actualSeconds: pick(NUMBERS.filter((n) => n === null || (Number.isFinite(n) && n >= 0))),
        }));
      const volume = aggregateVolume(acts, set.periods);
      const today = pick([first, set.to, "2026-06-17"]);
      const data: DashboardData = {
        periodSet: set,
        volume,
        plans: rand() > 0.15 ? aggregatePlans(plans, pairs, set.periods, today) : null,
        trend: rand() > 0.15 ? computeTrend(volume) : null,
        notices: [],
        lastSync: rand() > 0.5 ? null : "ok",
        activityCount: acts.length,
        planCount: plans.length,
        partial: false,
      };
      const view = buildDashboardView(data, { kind, count }, anchor);
      for (const s of strings(view)) {
        // sport labels are arbitrary data; only the numeric/derived strings are scanned
        expect(s, `iteration ${i}`).not.toMatch(/NaN|Infinity|\[object|undefined/);
      }
    }
  });
});
