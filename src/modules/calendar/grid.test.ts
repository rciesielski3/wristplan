import { afterEach, describe, expect, it } from "vitest";
import { addDays, buildGrid, localDay, parseAnchor, parseView, weekStart } from "./grid";

describe("parseView", () => {
  it.each([
    ["week", "week"],
    ["month", "month"],
    ["year", "week"],
    ["", "week"],
    [undefined, "week"],
  ] as const)("%s -> %s", (input, expected) => {
    expect(parseView(input)).toBe(expected);
  });
});

describe("parseAnchor", () => {
  const today = "2026-06-15";
  it("accepts a real day", () => expect(parseAnchor("2024-02-29", today)).toBe("2024-02-29"));
  it.each([undefined, "", "2026-02-30", "garbage", "2026-1-1", "1969-12-31", "2101-01-01"])(
    "falls back for %s",
    (v) => expect(parseAnchor(v, today)).toBe(today),
  );
});

describe("localDay", () => {
  it("uses local components", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDay(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});

describe("addDays and weekStart", () => {
  it("crosses month, year and leap boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
  });
  it("starts weeks on Monday", () => {
    expect(weekStart("2026-06-15")).toBe("2026-06-15");
    expect(weekStart("2026-06-21")).toBe("2026-06-15");
    expect(weekStart("2026-06-14")).toBe("2026-06-08");
  });
});

describe("buildGrid week", () => {
  it("covers Mon-Sun around the anchor", () => {
    const g = buildGrid("week", "2026-06-17");
    expect(g.from).toBe("2026-06-15");
    expect(g.to).toBe("2026-06-21");
    expect(g.weeks).toEqual([
      [
        "2026-06-15",
        "2026-06-16",
        "2026-06-17",
        "2026-06-18",
        "2026-06-19",
        "2026-06-20",
        "2026-06-21",
      ],
    ]);
    expect(g.month).toBeNull();
    expect(g.prev).toBe("2026-06-10");
    expect(g.next).toBe("2026-06-24");
  });
});

describe("buildGrid month", () => {
  it("pads with leading and trailing days", () => {
    const g = buildGrid("month", "2026-06-17");
    expect(g.label).toBe("June 2026");
    expect(g.from).toBe("2026-06-01");
    expect(g.to).toBe("2026-07-05");
    expect(g.weeks).toHaveLength(5);
    expect(g.month).toBe("2026-06");
    expect(g.prev).toBe("2026-05-01");
    expect(g.next).toBe("2026-07-01");
  });
  it("uses four rows for a Monday-start 28-day February", () => {
    const g = buildGrid("month", "2027-02-10");
    expect(g.weeks).toHaveLength(4);
    expect(g.from).toBe("2027-02-01");
    expect(g.to).toBe("2027-02-28");
  });
  it("uses six rows when needed and wraps years", () => {
    const g = buildGrid("month", "2026-11-30");
    expect(g.from).toBe("2026-10-26");
    expect(g.to).toBe("2026-12-06");
    expect(g.weeks).toHaveLength(6);
    expect(g.next).toBe("2026-12-01");
    expect(buildGrid("month", "2026-01-15").prev).toBe("2025-12-01");
  });
  it("stays within the list range limit", () => {
    const g = buildGrid("month", "2100-12-31");
    expect(g.weeks.length * 7).toBeLessThanOrEqual(42);
  });
});

describe("parseView with hostile input", () => {
  it.each([
    "WEEK",
    " week",
    "week ",
    "week,month",
    "__proto__",
    "constructor",
    "toString",
    "month\n",
    "<script>alert(1)</script>",
    "a".repeat(100_000),
  ])("falls back to week for %j", (v) => expect(parseView(v)).toBe("week"));
  it("falls back for an array value that bypassed the type", () => {
    expect(parseView(["month"] as unknown as string)).toBe("week");
  });
});

describe("parseAnchor with hostile input", () => {
  const today = "2026-06-15";
  it.each([
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "2026-04-31",
    "2023-02-29",
    "2100-02-29",
    "0000-00-00",
    "0000-01-01",
    "0099-01-01",
    " 2026-06-01",
    "2026-06-01 ",
    "2026-06-01\n",
    "2026-06-01T00:00:00Z",
    "2026-06-01'; DROP TABLE Activity;--",
    "2026-06-01<img src=x>",
    "２０２６-０６-０１",
    "-2026-06-01",
    "+2026-06-01",
    "2026/06/01",
    "1".repeat(100_000),
  ])("falls back for %j", (v) => expect(parseAnchor(v, today)).toBe(today));
  it("falls back for an array value that bypassed the type", () => {
    expect(parseAnchor(["2026-06-01"] as unknown as string, today)).toBe(today);
    expect(parseAnchor(["2026-06-01", "2026-06-02"] as unknown as string, today)).toBe(today);
  });
  it("accepts both clamp edges and rejects one day outside", () => {
    expect(parseAnchor("1970-01-01", today)).toBe("1970-01-01");
    expect(parseAnchor("2100-12-31", today)).toBe("2100-12-31");
    expect(parseAnchor("1969-12-31", today)).toBe(today);
    expect(parseAnchor("2101-01-01", today)).toBe(today);
  });
  it("accepts leap days in 2024 and 2028 only", () => {
    expect(parseAnchor("2024-02-29", today)).toBe("2024-02-29");
    expect(parseAnchor("2028-02-29", today)).toBe("2028-02-29");
    expect(parseAnchor("2100-02-29", today)).toBe(today);
  });
});

describe("weekStart anchors", () => {
  it("maps every weekday of a week to its Monday, including Sunday", () => {
    for (let i = 0; i < 7; i++) {
      expect(weekStart(addDays("2026-06-15", i))).toBe("2026-06-15");
    }
  });
  it("crosses month and year boundaries backwards", () => {
    expect(weekStart("2027-01-01")).toBe("2026-12-28");
    expect(weekStart("2024-03-03")).toBe("2024-02-26");
  });
  it("is stable at the clamp edges", () => {
    expect(weekStart("1970-01-01")).toBe("1969-12-29");
    expect(weekStart("2100-12-31")).toBe("2100-12-27");
  });
});

describe("buildGrid week boundaries", () => {
  it("builds a Sunday-anchored week ending on that Sunday", () => {
    const g = buildGrid("week", "2026-06-21");
    expect([g.from, g.to]).toEqual(["2026-06-15", "2026-06-21"]);
  });
  it("builds a Monday-anchored week starting on that Monday", () => {
    const g = buildGrid("week", "2026-06-15");
    expect([g.from, g.to]).toEqual(["2026-06-15", "2026-06-21"]);
  });
  it("spans the year boundary and navigates across it", () => {
    const g = buildGrid("week", "2026-12-31");
    expect([g.from, g.to]).toEqual(["2026-12-28", "2027-01-03"]);
    expect(g.weeks[0]).toContain("2027-01-01");
    expect(g.next).toBe("2027-01-07");
    expect(buildGrid("week", "2027-01-02").prev).toBe("2026-12-26");
  });
  it("includes the leap day and navigates over it", () => {
    for (const [y, anchor, from] of [
      ["2024", "2024-02-29", "2024-02-26"],
      ["2028", "2028-02-29", "2028-02-28"],
    ] as const) {
      const g = buildGrid("week", anchor);
      expect(g.from).toBe(from);
      expect(g.weeks[0]).toContain(`${y}-02-29`);
    }
    expect(buildGrid("week", "2024-02-26").prev).toBe("2024-02-19");
    expect(buildGrid("week", "2024-03-01").prev).toBe("2024-02-23");
    expect(buildGrid("week", "2100-02-28").next).toBe("2100-03-07");
  });
  it("always produces seven distinct ascending days", () => {
    const days = buildGrid("week", "2026-03-29").weeks[0] ?? [];
    expect(days).toHaveLength(7);
    expect([...days].sort()).toEqual(days);
    expect(new Set(days).size).toBe(7);
  });
});

describe("buildGrid month boundaries", () => {
  const expectConsistent = (g: ReturnType<typeof buildGrid>) => {
    const flat = g.weeks.flat();
    expect(flat[0]).toBe(g.from);
    expect(flat.at(-1)).toBe(g.to);
    expect(g.weeks.every((w) => w.length === 7)).toBe(true);
    expect(new Set(flat).size).toBe(flat.length);
    expect(weekStart(g.from)).toBe(g.from);
  };

  it("handles a month starting on Monday (June 2026) with no leading padding", () => {
    const g = buildGrid("month", "2026-06-30");
    expect(g.from).toBe("2026-06-01");
    expect(g.weeks).toHaveLength(5);
    expectConsistent(g);
  });
  it("handles a month starting on Sunday (Feb 2026) with six leading days", () => {
    const g = buildGrid("month", "2026-02-14");
    expect(g.from).toBe("2026-01-26");
    expect(g.to).toBe("2026-03-01");
    expect(g.weeks).toHaveLength(5);
    expectConsistent(g);
  });
  it("handles a month ending on Sunday with no trailing padding (May 2026)", () => {
    const g = buildGrid("month", "2026-05-31");
    expect(g.from).toBe("2026-04-27");
    expect(g.to).toBe("2026-05-31");
    expect(g.weeks).toHaveLength(5);
  });
  it("uses six rows for a 31-day month starting on Saturday (Aug 2026)", () => {
    const g = buildGrid("month", "2026-08-01");
    expect(g.from).toBe("2026-07-27");
    expect(g.to).toBe("2026-09-06");
    expect(g.weeks).toHaveLength(6);
    expectConsistent(g);
  });
  it.each([
    ["2024-02-10", "2024-01-29", "2024-03-03", "2024-01-01", "2024-03-01"],
    ["2028-02-29", "2028-01-31", "2028-03-05", "2028-01-01", "2028-03-01"],
    ["2100-02-01", "2100-02-01", "2100-02-28", "2100-01-01", "2100-03-01"],
    ["2027-02-28", "2027-02-01", "2027-02-28", "2027-01-01", "2027-03-01"],
  ])("February via %s grids %s..%s with prev %s and next %s", (anchor, from, to, prev, next) => {
    const g = buildGrid("month", anchor);
    expect([g.from, g.to, g.prev, g.next]).toEqual([from, to, prev, next]);
    expectConsistent(g);
  });
  it("includes Feb 29 only in leap years", () => {
    expect(buildGrid("month", "2024-02-10").weeks.flat()).toContain("2024-02-29");
    expect(buildGrid("month", "2028-02-10").weeks.flat()).toContain("2028-02-29");
    expect(buildGrid("month", "2100-02-10").weeks.flat()).not.toContain("2100-02-29");
    expect(buildGrid("month", "2100-02-10").weeks.flat()).toContain("2100-02-28");
  });
  it("wraps December to January and January to December", () => {
    const dec = buildGrid("month", "2026-12-15");
    expect(dec.label).toBe("December 2026");
    expect(dec.next).toBe("2027-01-01");
    expect(dec.to).toBe("2027-01-03");
    const jan = buildGrid("month", "2027-01-01");
    expect(jan.label).toBe("January 2027");
    expect(jan.prev).toBe("2026-12-01");
    expect(jan.from).toBe("2026-12-28");
  });
  it("round-trips next then prev back to the same month", () => {
    for (const anchor of ["2026-12-31", "2027-01-31", "2024-02-29", "2026-03-31"]) {
      const g = buildGrid("month", anchor);
      expect(buildGrid("month", g.next).prev).toBe(`${g.anchor.slice(0, 7)}-01`);
      expect(buildGrid("month", g.prev).next).toBe(`${g.anchor.slice(0, 7)}-01`);
    }
  });
  it("works at the lower clamp edge", () => {
    const g = buildGrid("month", "1970-01-01");
    expect(g.label).toBe("January 1970");
    expect(g.from).toBe("1969-12-29");
    expect(g.prev).toBe("1969-12-01");
    expectConsistent(g);
  });
  it("works at the upper clamp edge and next stays a valid ISO day", () => {
    const g = buildGrid("month", "2100-12-31");
    expect(g.label).toBe("December 2100");
    expect(g.next).toBe("2101-01-01");
    expect(g.to).toBe("2101-01-02");
    expectConsistent(g);
  });
  it("every month of 2024-2029 fits in 4-6 whole weeks covering the month", () => {
    for (let y = 2024; y <= 2029; y++) {
      for (let m = 1; m <= 12; m++) {
        const anchor = `${y}-${String(m).padStart(2, "0")}-01`;
        const g = buildGrid("month", anchor);
        const days = new Set(g.weeks.flat());
        expect(g.weeks.length).toBeGreaterThanOrEqual(4);
        expect(g.weeks.length).toBeLessThanOrEqual(6);
        const last = addDays(g.next, -1);
        expect(days.has(anchor) && days.has(last)).toBe(true);
        // no entirely foreign trailing or leading week
        expect(g.weeks[0]?.some((d) => d.startsWith(anchor.slice(0, 7)))).toBe(true);
        expect(g.weeks.at(-1)?.some((d) => d.startsWith(anchor.slice(0, 7)))).toBe(true);
      }
    }
  });
});

describe("timezone independence", () => {
  const zones = ["UTC", "Europe/Warsaw", "America/New_York", "Pacific/Auckland"];
  const anchors = [
    "2026-03-28",
    "2026-03-29",
    "2026-03-30",
    "2026-10-24",
    "2026-10-25",
    "2026-10-26",
    "2026-03-08",
    "2026-11-01",
    "2026-04-05",
    "2026-09-27",
  ];
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });
  const snapshot = (tz: string) => {
    process.env.TZ = tz;
    return anchors.map((a) => [
      buildGrid("week", a),
      buildGrid("month", a),
      weekStart(a),
      addDays(a, 1),
      addDays(a, -1),
    ]);
  };

  it("really switches the process timezone (guards the test itself)", () => {
    process.env.TZ = "Europe/Warsaw";
    expect(new Date("2026-07-01T12:00:00Z").getHours()).toBe(14);
    process.env.TZ = "America/New_York";
    expect(new Date("2026-07-01T12:00:00Z").getHours()).toBe(8);
  });
  it("produces identical grids in every timezone around DST changes", () => {
    const base = snapshot("UTC");
    for (const tz of zones) expect(snapshot(tz)).toEqual(base);
  });
  it("keeps the spring-forward week at seven consecutive days (Warsaw 2026-03-29)", () => {
    process.env.TZ = "Europe/Warsaw";
    expect(buildGrid("week", "2026-03-29").weeks[0]).toEqual([
      "2026-03-23",
      "2026-03-24",
      "2026-03-25",
      "2026-03-26",
      "2026-03-27",
      "2026-03-28",
      "2026-03-29",
    ]);
  });
  it("keeps the fall-back week at seven consecutive days (Warsaw 2026-10-25)", () => {
    process.env.TZ = "Europe/Warsaw";
    expect(buildGrid("week", "2026-10-25").weeks[0]).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
  });
  it("localDay follows the local wall clock just around midnight", () => {
    process.env.TZ = "Europe/Warsaw";
    expect(localDay(new Date("2026-10-24T21:59:59Z"))).toBe("2026-10-24");
    expect(localDay(new Date("2026-10-24T22:00:00Z"))).toBe("2026-10-25");
    expect(localDay(new Date("2026-03-28T22:59:59Z"))).toBe("2026-03-28");
    expect(localDay(new Date("2026-03-28T23:00:00Z"))).toBe("2026-03-29");
    process.env.TZ = "America/New_York";
    expect(localDay(new Date("2026-03-08T04:59:59Z"))).toBe("2026-03-07");
    expect(localDay(new Date("2026-03-08T05:00:00Z"))).toBe("2026-03-08");
    expect(localDay(new Date("2026-01-01T04:59:59Z"))).toBe("2025-12-31");
  });
  it("localDay pads small years and single digits", () => {
    process.env.TZ = "UTC";
    expect(localDay(new Date("2026-02-03T00:00:00Z"))).toBe("2026-02-03");
  });
});
