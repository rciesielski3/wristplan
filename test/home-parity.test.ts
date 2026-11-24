import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aggregateVolume,
  buildDashboardView,
  buildKpiTiles,
  buildPeriods,
  loadDashboard,
} from "../src/modules/analytics";
import {
  buildGrid,
  buildTodayCard,
  buildWeekStrip,
  CHIP_LABEL,
  createScheduleService,
  homeGrid,
  itemChip,
  loadCalendar,
} from "../src/modules/calendar";
import { createWorkoutRepository } from "../src/modules/workouts";
import { createTestDb, type TestDb } from "./db-helpers";
import { createFakePublisher } from "./fake-publisher";

// 2026-06-17 is a Wednesday; its week is 2026-06-15 .. 2026-06-21.
const TODAY = "2026-06-17";
const step = { kind: "work", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 2 } };

let t: TestDb;
let seq = 0;

const read = (grid: ReturnType<typeof buildGrid>) =>
  loadCalendar(
    t.db,
    () => createScheduleService({ db: t.db, publisher: createFakePublisher() }),
    grid,
    TODAY,
  );
const plan = async (date: string, extra: object = {}) => {
  const w = await createWorkoutRepository(t.db).create({
    name: `W${seq++}`,
    sport: "run",
    steps: [step],
  });
  return (
    await t.db.scheduledWorkout.create({
      data: {
        workoutId: w.id,
        date,
        status: "published",
        externalId: `wristplan-p${seq++}`,
        ...extra,
      },
    })
  ).id;
};
const activity = (id: string, startTime: string, extra: object = {}) =>
  t.db.activity.create({
    data: {
      garminActivityId: id,
      startTime: new Date(startTime),
      lastSyncedAt: new Date("2026-06-17T00:00:00Z"),
      sport: "running",
      durationSeconds: 700,
      distanceMeters: 5000,
      ...extra,
    },
  });

beforeAll(async () => {
  t = createTestDb();
  await plan("2026-06-14"); // last Sunday, never done: missed, outside the strip
  await plan("2026-06-15"); // Monday, matched by g1
  await activity("g1", "2026-06-15T08:00:00Z");
  await plan("2026-06-16", { matchSource: "none" }); // Tuesday, manual "no match"
  await activity("g2", "2026-06-16T08:00:00Z"); // stays unplanned: the plan opted out
  await plan(TODAY); // today, due
  await plan("2026-06-18"); // two plans claim one activity
  await plan("2026-06-18");
  await activity("g3", "2026-06-18T08:00:00Z");
  await plan("2026-06-19"); // upcoming
  await activity("g4", "2026-06-20T23:59:59.999Z", { durationSeconds: null, distanceMeters: null });
  await plan("2026-06-22"); // next Monday: grid only, not in the strip
  await activity("g5", "2026-03-01T08:00:00Z"); // outside the eight weeks
});
afterAll(() => t.cleanup());

describe("home week strip parity with /calendar", () => {
  it("shows the same plans, activities and states as the calendar week view", async () => {
    const week = await read(buildGrid("week", TODAY));
    const home = await read(homeGrid(TODAY));
    const strip = buildWeekStrip(home, TODAY);

    for (const day of strip) {
      const cal = week.days[day.date];
      const scheduled = cal?.scheduled ?? [];
      expect(day.planned, day.date).toBe(scheduled.length);
      expect(day.completed, day.date).toBe(
        scheduled.filter((s) => s.state === "matched").length + (cal?.activities.length ?? 0),
      );
      // Same data under both grids for every strip day.
      expect(home.days[day.date], day.date).toEqual(cal);
    }
  });

  it("maps calendar match states to the documented chips", async () => {
    const home = await read(homeGrid(TODAY));
    const strip = buildWeekStrip(home, TODAY);
    expect(strip.map((d) => [d.date.slice(5), d.planned, d.completed, d.chip])).toEqual([
      ["06-15", 1, 1, "matched"],
      ["06-16", 1, 1, "no-match"], // the opted-out plan is not counted, g2 is unplanned
      ["06-17", 1, 0, "due"],
      ["06-18", 2, 1, "upcoming"], // one pair, one unmatched plan: never two completions for g3
      ["06-19", 1, 0, "upcoming"],
      ["06-20", 0, 1, null], // unplanned g4 near the end of the UTC day
      ["06-21", 0, 0, null],
    ]);
  });

  it("two plans claiming one activity produce exactly one match", async () => {
    const home = await read(homeGrid(TODAY));
    const states = (home.days["2026-06-18"]?.scheduled ?? []).map((s) => s.state).sort();
    expect(states).toEqual(["matched", "planned"]);
    expect(home.days["2026-06-18"]?.activities).toEqual([]);
  });

  it("the Today card agrees with the calendar for today and for the next planned day", async () => {
    const home = await read(homeGrid(TODAY));
    const today = buildTodayCard(home, TODAY);
    expect(today.heading).toBe("Today");
    const calToday = home.days[TODAY]?.scheduled ?? [];
    expect(today.items.map((i) => i.id)).toEqual(calToday.map((s) => s.id));
    expect(today.items.map((i) => i.chip)).toEqual(calToday.map((s) => itemChip(s, TODAY)));
    expect(CHIP_LABEL[today.items[0]?.chip ?? "no-match"]).toBe("Due");

    const next = buildTodayCard(await read(homeGrid("2026-06-21")), "2026-06-21");
    expect(next.heading).toBe("Next planned, 2026-06-22");
    expect(next.items.map((i) => i.chip)).toEqual(["upcoming"]);
  });

  it("the nearest next plan beyond the two-week horizon is not shown", async () => {
    const home = await read(homeGrid("2026-05-20"));
    expect(buildTodayCard(home, "2026-05-20").date).toBeNull();
  });
});

describe("home KPI tiles parity with /dashboard", () => {
  it("equals the dashboard Total row for the same eight weeks", async () => {
    const query = { kind: "week", count: 8 } as const;
    const data = await loadDashboard(t.db, { ...query, anchor: TODAY }, TODAY);
    const tiles = buildKpiTiles(data);
    const view = buildDashboardView(data, query, TODAY);
    const total = view.volume.rows.at(-1)?.total;

    // g1..g4 are inside the eight weeks; g5 (March) is not.
    expect(tiles[0]).toEqual({ label: "Activities", value: "4" });
    expect(tiles.map((x) => x.value).join(" · ")).toBe(total);
    expect(tiles[1]?.value).toBe("35:00 (3 of 4)");
    expect(tiles[2]?.value).toBe("15.00 km (3 of 4)");
  });

  it("matches the dashboard when no activity has a duration or distance", async () => {
    const t2 = createTestDb();
    try {
      await t2.db.activity.create({
        data: {
          garminActivityId: "n1",
          startTime: new Date("2026-06-16T08:00:00Z"),
          lastSyncedAt: new Date("2026-06-17T00:00:00Z"),
        },
      });
      const query = { kind: "week", count: 8 } as const;
      const data = await loadDashboard(t2.db, { ...query, anchor: TODAY }, TODAY);
      const tiles = buildKpiTiles(data);
      expect(tiles.map((x) => x.value)).toEqual(["1", "— (0 of 1)", "— (0 of 1)"]);
      expect(tiles.map((x) => x.value).join(" · ")).toBe(
        buildDashboardView(data, query, TODAY).volume.rows.at(-1)?.total,
      );
    } finally {
      await t2.cleanup();
    }
  });

  it("an empty database yields zero tiles and no throw", async () => {
    const t2 = createTestDb();
    try {
      const data = await loadDashboard(t2.db, { kind: "week", count: 8, anchor: TODAY }, TODAY);
      expect(buildKpiTiles(data)[0]).toEqual({ label: "Activities", value: "0" });
    } finally {
      await t2.cleanup();
    }
  });
});

describe("KPI tiles with unusable values", () => {
  const run = (durationSeconds: number | null, distanceMeters: number | null) => ({
    day: "2026-06-16",
    sport: "running",
    durationSeconds,
    distanceMeters,
  });
  const tilesFor = (acts: ReturnType<typeof run>[]) =>
    buildKpiTiles({
      volume: aggregateVolume(acts, buildPeriods("week", TODAY, 8).periods),
    } as unknown as Parameters<typeof buildKpiTiles>[0]).map((x) => x.value);

  it("treats null, NaN, Infinity and negative values as unknown", () => {
    expect(
      tilesFor([
        run(600, 1000),
        run(null, null),
        run(Number.NaN, Number.NaN),
        run(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        run(-5, -5),
      ]),
    ).toEqual(["5", "10:00 (1 of 5)", "1.00 km (1 of 5)"]);
  });

  it("is unaffected by input order", () => {
    const acts = [run(0.1, 0.1), run(0.2, 0.2), run(0.3, 0.3)];
    expect(tilesFor(acts)).toEqual(tilesFor([...acts].reverse()));
  });
});
