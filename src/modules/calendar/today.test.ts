import { describe, expect, it } from "vitest";
import { buildTodayCard, buildWeekStrip, homeGrid, itemChip } from "./today";
import type { CalendarData, CalendarDay, MatchState, ScheduledItem } from "./view";

// 2026-06-17 is a Wednesday; its week is 2026-06-15 .. 2026-06-21.
const TODAY = "2026-06-17";

const item = (id: string, date: string, state: MatchState): ScheduledItem => ({
  id,
  date,
  name: `Plan ${id}`,
  summary: "run, 1 step",
  status: "published",
  lastError: null,
  state,
  matchSource: null,
  linkMissing: false,
  match: null,
  linkCandidates: [],
});
const data = (days: Record<string, Partial<CalendarDay>>): CalendarData => ({
  days: Object.fromEntries(
    Object.entries(days).map(([d, v]) => [d, { scheduled: [], activities: [], ...v }]),
  ),
  workouts: [],
  notices: [],
});
const activity = { id: "a", name: "Run", sport: "running", duration: "1:00", distance: "1 km" };

describe("homeGrid", () => {
  it("spans this week and the next", () => {
    const g = homeGrid(TODAY);
    expect([g.from, g.to]).toEqual(["2026-06-15", "2026-06-28"]);
  });
});

describe("itemChip", () => {
  it("maps match state and day to a chip", () => {
    expect(itemChip({ state: "matched", date: TODAY }, TODAY)).toBe("matched");
    expect(itemChip({ state: "no-match", date: TODAY }, TODAY)).toBe("no-match");
    expect(itemChip({ state: "missed", date: "2026-06-10" }, TODAY)).toBe("due");
    expect(itemChip({ state: "planned", date: TODAY }, TODAY)).toBe("due");
    expect(itemChip({ state: "planned", date: "2026-06-18" }, TODAY)).toBe("upcoming");
  });
});

describe("buildTodayCard", () => {
  it("lists today's plans", () => {
    const d = data({
      [TODAY]: { scheduled: [item("a", TODAY, "planned"), item("b", TODAY, "matched")] },
    });
    const card = buildTodayCard(d, TODAY);
    expect(card.heading).toBe("Today");
    expect(card.items.map((i) => [i.id, i.chip])).toEqual([
      ["a", "due"],
      ["b", "matched"],
    ]);
  });

  it("falls back to the nearest upcoming day and ignores the past", () => {
    const d = data({
      "2026-06-16": { scheduled: [item("old", "2026-06-16", "missed")] },
      "2026-06-25": { scheduled: [item("late", "2026-06-25", "planned")] },
      "2026-06-19": { scheduled: [item("soon", "2026-06-19", "planned")] },
      "2026-06-18": { activities: [activity] },
    });
    const card = buildTodayCard(d, TODAY);
    expect(card.heading).toBe("Next planned, 2026-06-19");
    expect(card.items.map((i) => [i.id, i.chip])).toEqual([["soon", "upcoming"]]);
  });

  it("is empty with nothing ahead", () => {
    expect(buildTodayCard(data({}), TODAY)).toEqual({ heading: "Today", date: null, items: [] });
    expect(
      buildTodayCard(
        data({ "2026-06-10": { scheduled: [item("x", "2026-06-10", "missed")] } }),
        TODAY,
      ).items,
    ).toEqual([]);
  });
});

describe("buildWeekStrip", () => {
  it("returns Monday to Sunday with counts and chips", () => {
    const strip = buildWeekStrip(
      data({
        "2026-06-15": {
          scheduled: [{ ...item("m", "2026-06-15", "matched"), match: null }],
          activities: [activity],
        },
        "2026-06-16": { scheduled: [item("n", "2026-06-16", "no-match")] },
        "2026-06-17": { scheduled: [item("t", TODAY, "planned"), item("u", TODAY, "matched")] },
        "2026-06-19": { scheduled: [item("f", "2026-06-19", "planned")] },
        "2026-06-20": { activities: [activity, activity] },
        "2026-06-29": { scheduled: [item("next", "2026-06-29", "planned")] },
      }),
      TODAY,
    );
    expect(strip.map((d) => d.date)).toEqual([
      "2026-06-15",
      "2026-06-16",
      "2026-06-17",
      "2026-06-18",
      "2026-06-19",
      "2026-06-20",
      "2026-06-21",
    ]);
    expect(strip.map((d) => d.weekday).join(" ")).toBe("Mon Tue Wed Thu Fri Sat Sun");
    expect(strip.map((d) => [d.planned, d.completed, d.chip])).toEqual([
      [1, 2, "matched"],
      [1, 0, "no-match"],
      [2, 1, "due"],
      [0, 0, null],
      [1, 0, "upcoming"],
      [0, 2, null],
      [0, 0, null],
    ]);
    expect(strip.filter((d) => d.isToday).map((d) => d.date)).toEqual([TODAY]);
  });
});

describe("week boundaries", () => {
  const edge = (today: string) => {
    const strip = buildWeekStrip(data({}), today);
    return [strip[0]?.date, strip[6]?.date, strip.filter((d) => d.isToday).map((d) => d.weekday)];
  };

  it.each([
    ["Monday starts its own week", "2026-06-15", "2026-06-15", "2026-06-21", "Mon"],
    [
      "Sunday ends the week that began six days earlier",
      "2026-06-21",
      "2026-06-15",
      "2026-06-21",
      "Sun",
    ],
    [
      "Monday after a Sunday belongs to the next week",
      "2026-06-22",
      "2026-06-22",
      "2026-06-28",
      "Mon",
    ],
    ["a week crossing the year end", "2026-12-31", "2026-12-28", "2027-01-03", "Thu"],
    ["a week crossing a leap day", "2024-02-29", "2024-02-26", "2024-03-03", "Thu"],
    ["a week crossing a DST change date", "2026-03-29", "2026-03-23", "2026-03-29", "Sun"],
  ])("%s", (_name, today, from, to, weekday) => {
    expect(edge(today)).toEqual([from, to, [weekday]]);
  });

  it("homeGrid always covers 14 days from Monday", () => {
    for (const today of ["2026-06-15", "2026-06-21", "2026-12-31", "2024-02-29"]) {
      const g = homeGrid(today);
      expect(new Date(`${g.from}T00:00:00Z`).getUTCDay()).toBe(1);
      expect((Date.parse(`${g.to}T00:00:00Z`) - Date.parse(`${g.from}T00:00:00Z`)) / 864e5).toBe(
        13,
      );
    }
  });

  it("the Today card ignores plans on the day before today even at a week start", () => {
    const d = data({ "2026-06-14": { scheduled: [item("old", "2026-06-14", "missed")] } });
    expect(buildTodayCard(d, "2026-06-15").date).toBeNull();
  });

  it("counts a past unmatched plan as due in the strip", () => {
    const strip = buildWeekStrip(
      data({ "2026-06-15": { scheduled: [item("x", "2026-06-15", "missed")] } }),
      TODAY,
    );
    expect(strip[0]?.chip).toBe("due");
  });

  it("prefers due over upcoming over matched over no-match on a busy day", () => {
    const day = (...states: MatchState[]) =>
      buildWeekStrip(
        data({
          "2026-06-19": { scheduled: states.map((s, i) => item(`i${i}`, "2026-06-19", s)) },
        }),
        TODAY,
      )[4]?.chip;
    expect(day("matched", "no-match")).toBe("matched");
    expect(day("no-match", "planned")).toBe("upcoming");
    expect(day("matched", "planned", "missed")).toBe("due");
  });
});
