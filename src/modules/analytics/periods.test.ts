import { describe, expect, it } from "vitest";
import { buildPeriods, parsePeriodCount, parsePeriodKind, shiftAnchor } from "./periods";

describe("parsePeriodKind", () => {
  it.each([
    ["week", "week"],
    ["month", "month"],
    [undefined, "week"],
    ["", "week"],
    ["Month", "week"],
    [["month"], "week"],
  ] as const)("%j -> %s", (input, expected) => {
    expect(parsePeriodKind(input)).toBe(expected);
  });
});

describe("parsePeriodCount", () => {
  it.each([
    ["week", "4", 4],
    ["week", "12", 12],
    ["month", "3", 3],
    ["month", "12", 12],
    ["week", undefined, 8],
    ["month", undefined, 6],
    ["week", "", 8],
    ["week", "3", 8],
    ["month", "8", 6],
    ["week", "-4", 8],
    ["week", "8.0", 8],
    ["week", "4.5", 8],
    ["week", "04", 8],
    ["week", " 4", 8],
    ["week", "0", 8],
    ["week", "99999999999999999999", 8],
    ["month", "Infinity", 6],
    ["month", "NaN", 6],
    ["week", ["4"], 8],
    ["week", [], 8],
  ] as const)("%s %j -> %i", (kind, input, expected) => {
    expect(parsePeriodCount(kind, input)).toBe(expected);
  });
});

describe("buildPeriods weeks", () => {
  it("ends at the anchor's Monday-Sunday week, oldest first", () => {
    const set = buildPeriods("week", "2026-06-17", 4);
    expect(set.periods.map((p) => p.start)).toEqual([
      "2026-05-25",
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
    ]);
    expect(set.periods[3]).toEqual({
      key: "2026-06-15",
      start: "2026-06-15",
      end: "2026-06-21",
      label: "Mon 2026-06-15",
    });
    expect([set.from, set.to]).toEqual(["2026-05-25", "2026-06-21"]);
  });

  it("treats Monday and Sunday anchors as the same week", () => {
    expect(buildPeriods("week", "2026-06-15", 4)).toEqual(buildPeriods("week", "2026-06-21", 4));
    expect(buildPeriods("week", "2026-06-22", 4).periods.at(-1)?.start).toBe("2026-06-22");
  });

  it("crosses year rollover", () => {
    const set = buildPeriods("week", "2026-01-02", 4);
    expect(set.from).toBe("2025-12-08");
    expect(set.periods.at(-1)?.end).toBe("2026-01-04");
  });

  it("handles leap days", () => {
    expect(buildPeriods("week", "2024-03-01", 4).periods.map((p) => p.end)).toContain("2024-03-03");
    expect(buildPeriods("week", "2024-03-04", 4).periods.at(-2)?.end).toBe("2024-03-03");
    expect(buildPeriods("week", "2100-03-01", 4).periods.at(-2)).toMatchObject({
      start: "2100-02-22",
      end: "2100-02-28",
    });
  });

  it("is contiguous without gaps or overlap", () => {
    const { periods } = buildPeriods("week", "2028-03-05", 12);
    expect(periods).toHaveLength(12);
    for (let i = 1; i < periods.length; i++) {
      const next = new Date(`${periods[i - 1]?.end}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      expect(next.toISOString().slice(0, 10)).toBe(periods[i]?.start);
    }
  });

  it("falls back to the default count for invalid n", () => {
    expect(buildPeriods("week", "2026-06-17", 5).periods).toHaveLength(8);
    expect(buildPeriods("week", "2026-06-17", Number.NaN).periods).toHaveLength(8);
    expect(buildPeriods("month", "2026-06-17", -1).periods).toHaveLength(6);
  });
});

describe("buildPeriods months", () => {
  it("labels and bounds calendar months", () => {
    const set = buildPeriods("month", "2026-06-30", 3);
    expect(set.periods).toEqual([
      { key: "2026-04", start: "2026-04-01", end: "2026-04-30", label: "April 2026" },
      { key: "2026-05", start: "2026-05-01", end: "2026-05-31", label: "May 2026" },
      { key: "2026-06", start: "2026-06-01", end: "2026-06-30", label: "June 2026" },
    ]);
    expect([set.from, set.to]).toEqual(["2026-04-01", "2026-06-30"]);
  });

  it("rolls over the year", () => {
    const set = buildPeriods("month", "2026-02-01", 6);
    expect(set.periods[0]).toMatchObject({ key: "2025-09", label: "September 2025" });
    expect(set.periods[5]).toMatchObject({ key: "2026-02", end: "2026-02-28" });
  });

  it("knows leap Februaries", () => {
    const end = (anchor: string) => buildPeriods("month", anchor, 3).periods.at(-1)?.end;
    expect(end("2024-02-10")).toBe("2024-02-29");
    expect(end("2028-02-10")).toBe("2028-02-29");
    expect(end("2100-02-10")).toBe("2100-02-28");
    expect(end("2026-02-10")).toBe("2026-02-28");
  });

  it("covers December correctly", () => {
    expect(buildPeriods("month", "2026-12-31", 3).periods.at(-1)).toMatchObject({
      start: "2026-12-01",
      end: "2026-12-31",
    });
  });
});

describe("shiftAnchor", () => {
  it("moves weeks by n weeks", () => {
    expect(shiftAnchor("week", "2026-06-17", 8, "prev")).toBe("2026-04-22");
    expect(shiftAnchor("week", "2026-06-17", 4, "next")).toBe("2026-07-15");
    expect(shiftAnchor("week", "2024-02-29", 4, "next")).toBe("2024-03-28");
  });

  it("moves months by n months to the first of the month", () => {
    expect(shiftAnchor("month", "2026-01-31", 3, "prev")).toBe("2025-10-01");
    expect(shiftAnchor("month", "2026-11-15", 6, "next")).toBe("2027-05-01");
    expect(shiftAnchor("month", "2026-03-31", 12, "prev")).toBe("2025-03-01");
  });

  it("normalizes an invalid count", () => {
    expect(shiftAnchor("week", "2026-06-17", 99, "next")).toBe("2026-08-12");
  });

  it("next then prev lands in the same period window for months", () => {
    const next = shiftAnchor("month", "2026-06-20", 6, "next");
    expect(buildPeriods("month", shiftAnchor("month", next, 6, "prev"), 6).to).toBe("2026-06-30");
  });
});
