import { describe, expect, it } from "vitest";
import {
  daysFromCivil,
  daysFromIso,
  isoFromDays,
  mulberry32,
  oraclePeriods,
} from "../../../test/analytics-oracle";
import { parseAnchor } from "../calendar/grid";
import {
  buildPeriods,
  DEFAULT_PERIOD_COUNT,
  PERIOD_COUNTS,
  type PeriodKind,
  parsePeriodCount,
  parsePeriodKind,
  shiftAnchor,
} from "./periods";

const MIN = daysFromCivil(1970, 1, 1);
const MAX = daysFromCivil(2100, 12, 31);
const KINDS: PeriodKind[] = ["week", "month"];

const EDGE_ANCHORS = [
  "1970-01-01",
  "1970-01-04",
  "1970-01-05",
  "2100-12-31",
  "2100-12-27",
  "2100-02-28",
  "2100-03-01",
  "2024-02-29",
  "2024-03-01",
  "2024-12-30",
  "2024-12-31",
  "2025-01-01",
  "2028-02-29",
  "2000-02-29",
  "2000-03-01",
  "2099-12-31",
  "1999-12-31",
  "2026-11-23",
  "2026-11-29",
  "2026-11-22",
];

describe("oracle self-check", () => {
  it("round-trips every day in the supported range", () => {
    for (let d = MIN; d <= MAX; d += 1) {
      const iso = isoFromDays(d);
      if (daysFromIso(iso) !== d) throw new Error(`round trip failed at ${d} ${iso}`);
      if (new Date(`${iso}T00:00:00.000Z`).getTime() !== d * 86_400_000) {
        throw new Error(`oracle disagrees with Date at ${iso}`);
      }
    }
  });
});

describe("buildPeriods against an independent calendar oracle", () => {
  const compare = (kind: PeriodKind, anchor: string, n: number) => {
    const expected = oraclePeriods(kind, anchor, n);
    const actual = buildPeriods(kind, anchor, n);
    expect(
      actual.periods.map(({ key, start, end, label }) => ({ key, start, end, label })),
    ).toEqual(expected.map(({ key, start, end, label }) => ({ key, start, end, label })));
    expect(actual.from).toBe(expected[0]?.start);
    expect(actual.to).toBe(expected[expected.length - 1]?.end);
    expect(actual.kind).toBe(kind);
  };

  for (const kind of KINDS) {
    for (const n of PERIOD_COUNTS[kind]) {
      it(`${kind} x${n}: edge anchors`, () => {
        for (const a of EDGE_ANCHORS) compare(kind, a, n);
      });
      it(`${kind} x${n}: 400 seeded random anchors`, () => {
        const rnd = mulberry32(n * 7 + (kind === "week" ? 1 : 2));
        for (let i = 0; i < 400; i++) {
          compare(kind, isoFromDays(MIN + Math.floor(rnd() * (MAX - MIN + 1))), n);
        }
      });
    }
  }

  it("covers every day of the supported anchor range exactly once per window (contiguity)", () => {
    for (const kind of KINDS) {
      for (let d = MIN; d <= MAX; d += 13) {
        const { periods } = buildPeriods(kind, isoFromDays(d), 12);
        periods.forEach((p, i) => {
          const prev = periods[i - 1];
          if (prev) expect(daysFromIso(p.start)).toBe(daysFromIso(prev.end) + 1);
          expect(daysFromIso(p.start)).toBeLessThanOrEqual(daysFromIso(p.end));
        });
      }
    }
  });

  it("anchors on Monday and Sunday land in the same week bucket", () => {
    const mon = buildPeriods("week", "2026-11-23", 4);
    const sun = buildPeriods("week", "2026-11-29", 4);
    const prevSun = buildPeriods("week", "2026-11-22", 4);
    expect(sun).toEqual(mon);
    expect(mon.to).toBe("2026-11-29");
    expect(prevSun.to).toBe("2026-11-22");
  });

  it("never produces years outside 1969..2101 even at the clamp edges (invalid dates impossible)", () => {
    for (const kind of KINDS) {
      for (const a of ["1970-01-01", "2100-12-31"]) {
        const { periods, from, to } = buildPeriods(kind, a, 12);
        for (const iso of [from, to, ...periods.flatMap((p) => [p.start, p.end])]) {
          expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          const year = Number(iso.slice(0, 4));
          expect(year).toBeGreaterThanOrEqual(1969);
          expect(year).toBeLessThanOrEqual(2101);
        }
      }
    }
  });

  it("falls back to the default size for counts outside the allowed sets", () => {
    for (const bad of [0, -1, 1, 5, 7, 9, 13, 100, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildPeriods("week", "2026-11-23", bad).periods).toHaveLength(
        DEFAULT_PERIOD_COUNT.week,
      );
      expect(buildPeriods("month", "2026-11-23", bad).periods).toHaveLength(
        DEFAULT_PERIOD_COUNT.month,
      );
    }
    expect(buildPeriods("week", "2026-11-23", 6).periods).toHaveLength(8); // month-only count
    expect(buildPeriods("month", "2026-11-23", 8).periods).toHaveLength(6); // week-only count
  });
});

describe("shiftAnchor", () => {
  it("prev then next returns the starting week bucket for every allowed count", () => {
    const rnd = mulberry32(99);
    for (const n of PERIOD_COUNTS.week) {
      for (let i = 0; i < 200; i++) {
        const a = isoFromDays(MIN + 400 + Math.floor(rnd() * (MAX - MIN - 800)));
        const back = shiftAnchor("week", shiftAnchor("week", a, n, "prev"), n, "next");
        expect(back).toBe(a);
        expect(daysFromIso(a) - daysFromIso(shiftAnchor("week", a, n, "prev"))).toBe(7 * n);
      }
    }
  });

  it("prev then next returns the same month for every allowed count, including from the 31st", () => {
    const rnd = mulberry32(100);
    const anchors = ["2024-01-31", "2024-03-31", "2023-12-31", "2100-12-31", "2024-02-29"];
    for (let i = 0; i < 200; i++) anchors.push(isoFromDays(MIN + 400 + Math.floor(rnd() * 40000)));
    for (const n of PERIOD_COUNTS.month) {
      for (const a of anchors) {
        const shifted = shiftAnchor("month", a, n, "prev");
        expect(shifted.slice(8)).toBe("01");
        const back = shiftAnchor("month", shifted, n, "next");
        expect(back.slice(0, 7)).toBe(a.slice(0, 7));
        const months = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7));
        expect(months(a) - months(shifted)).toBe(n);
      }
    }
  });

  it("shifts the window by exactly its own size so adjacent windows tile without overlap", () => {
    for (const kind of KINDS) {
      for (const n of PERIOD_COUNTS[kind]) {
        const a = "2026-11-23";
        const cur = buildPeriods(kind, a, n);
        const prev = buildPeriods(kind, shiftAnchor(kind, a, n, "prev"), n);
        expect(daysFromIso(cur.from) - daysFromIso(prev.to)).toBe(1);
      }
    }
  });

  it("an invalid count shifts by the default size", () => {
    expect(shiftAnchor("week", "2026-11-23", 5, "prev")).toBe("2026-09-28");
    expect(shiftAnchor("month", "2026-11-23", 5, "next")).toBe("2027-05-01");
  });

  it("beyond the clamp range returns a well-formed date outside 1970..2100 (UI must re-clamp)", () => {
    const before = shiftAnchor("week", "1970-01-01", 12, "prev");
    const after = shiftAnchor("month", "2100-12-31", 12, "next");
    expect(before).toBe("1969-10-09");
    expect(after).toBe("2101-12-01");
    // parseAnchor rejects both, so a prev/next link built from them silently jumps to today.
    expect(parseAnchor(before, "2026-11-23")).toBe("2026-11-23");
    expect(parseAnchor(after, "2026-11-23")).toBe("2026-11-23");
  });
});

describe("parsePeriodKind / parsePeriodCount with hostile input", () => {
  it.each([
    "__proto__",
    "constructor",
    "toString",
    "WEEK",
    "week ",
    " month",
    "month\n",
    "mönth",
    "weeк",
  ])("kind %j falls back to week", (v) => {
    expect(parsePeriodKind(v)).toBe("week");
  });

  it("kind accepts nothing but the two literals", () => {
    expect(parsePeriodKind(["week", "month"])).toBe("week");
    expect(parsePeriodKind(["month"])).toBe("week");
    expect(parsePeriodKind(undefined)).toBe("week");
  });

  it.each([
    "8 ",
    " 8",
    "08",
    "+8",
    "-8",
    "1e1",
    "0x8",
    "8.",
    "8.0",
    "٨", // arabic-indic digit eight
    "８", // fullwidth digit eight
    "__proto__",
    "constructor",
    "",
    "0",
    "8\n",
    "1".repeat(400),
    "4\u0000",
  ])("week count %j falls back to 8", (v) => {
    expect(parsePeriodCount("week", v)).toBe(8);
  });

  it("month count junk falls back to 6 and valid values pass", () => {
    for (const v of ["1e1", "٣", "03", "+3", "6 ", "12 ", ["3"], undefined, "__proto__"]) {
      expect(parsePeriodCount("month", v as string)).toBe(6);
    }
    for (const n of PERIOD_COUNTS.month) expect(parsePeriodCount("month", String(n))).toBe(n);
    for (const n of PERIOD_COUNTS.week) expect(parsePeriodCount("week", String(n))).toBe(n);
  });
});
