import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { addDays, SCHEDULE_LIST_LIMIT } from "../calendar";
import { createWorkoutRepository, WORKOUT_LIST_LIMIT } from "../workouts";
import { DASHBOARD_ACTIVITY_LIMIT, loadDashboard } from "./load";

const TODAY = "2026-06-17";
const week4 = { kind: "week", count: 4, anchor: TODAY } as const; // 2026-05-25 .. 2026-06-21

let t: TestDb;
let definition = "";
let seq = 0;
const load = (p: Parameters<typeof loadDashboard>[1] = week4, today = TODAY) =>
  loadDashboard(t.db, p, today);

const workouts = async (n: number) => {
  const ids = Array.from({ length: n }, (_, i) => `qw${seq++}-${i}`);
  await t.db.workout.createMany({ data: ids.map((id) => ({ id, definition })) });
  return ids;
};
const plan = async (date: string, extra: object = {}) => {
  const [workoutId] = await workouts(1);
  return (
    await t.db.scheduledWorkout.create({
      data: {
        workoutId: workoutId as string,
        date,
        status: "published",
        externalId: `wristplan-q${seq++}`,
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
      lastSyncedAt: new Date(0),
      sport: "running",
      durationSeconds: 700,
      distanceMeters: 5000,
      ...extra,
    },
  });
const manyActivities = (n: number, from: string) =>
  t.db.activity.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      garminActivityId: `m${i}`,
      startTime: new Date(Date.parse(from) + i * 1000),
      lastSyncedAt: new Date(0),
      sport: "running",
      durationSeconds: 1,
    })),
  });
const planGrid = (n: number) =>
  // (workoutId, date) is unique: spread n plans over 28 days and enough workouts.
  workouts(Math.ceil(n / 28)).then((ids) =>
    t.db.scheduledWorkout.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        workoutId: ids[Math.floor(i / 28)] as string,
        date: addDays("2026-05-25", i % 28),
        status: "published",
        externalId: `wristplan-g${seq}-${i}`,
      })),
    }),
  );

beforeEach(async () => {
  t = createTestDb();
  const w = await createWorkoutRepository(t.db).create({
    name: "Pool",
    sport: "run",
    steps: [{ kind: "work", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 2 } }],
  });
  definition = (await t.db.workout.findUniqueOrThrow({ where: { id: w.id } })).definition;
  await t.db.workout.delete({ where: { id: w.id } });
});
afterEach(() => {
  vi.restoreAllMocks();
  return t.cleanup();
});

describe("loadDashboard today boundary and bucketing", () => {
  it("treats a plan dated today as due and tomorrow as upcoming", async () => {
    await plan("2026-06-17");
    await plan("2026-06-18");
    await plan("2026-06-16");
    const o = (await load()).plans?.overall;
    expect(o).toMatchObject({ due: 2, upcoming: 1, matched: 0 });
  });

  it("buckets plans by their date string across a month boundary", async () => {
    await plan("2026-05-31");
    await plan("2026-06-01");
    const d = await load({ kind: "month", count: 3, anchor: "2026-06-30" }, "2026-06-30");
    const keys = d.periodSet.periods.map((p) => p.key);
    expect(keys).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(d.plans?.perPeriod.map((p) => p.due)).toEqual([0, 1, 1]);
  });

  it("buckets activities by UTC day at the first and last millisecond", async () => {
    await activity("a-last-may", "2026-05-31T23:59:59.999Z");
    await activity("a-first-jun", "2026-06-01T00:00:00.000Z");
    const d = await load({ kind: "month", count: 3, anchor: "2026-06-30" }, "2026-06-30");
    const counts = d.volume.totals.map((p) => p.count);
    expect(counts).toEqual([0, 1, 1]);
  });

  it("includes the first and last millisecond of the range and excludes the neighbours", async () => {
    await activity("before", "2026-05-24T23:59:59.999Z");
    await activity("first", "2026-05-25T00:00:00.000Z");
    await activity("last", "2026-06-21T23:59:59.999Z");
    await activity("after", "2026-06-22T00:00:00.000Z");
    const d = await load();
    expect(d.activityCount).toBe(2);
    expect(d.volume.overall.count).toBe(2);
  });

  it("includes plans on both range edges and excludes the days around them", async () => {
    await plan("2026-05-24");
    await plan("2026-05-25");
    await plan("2026-06-21");
    await plan("2026-06-22");
    const d = await load({ ...week4 }, "2026-12-31");
    expect(d.planCount).toBe(2);
    expect(d.plans?.overall.due).toBe(2);
  });

  it("does not pair an activity with a plan on the neighbouring UTC day", async () => {
    await plan("2026-06-16");
    await activity("late", "2026-06-15T23:59:59.999Z");
    await activity("early", "2026-06-17T00:00:00.000Z");
    expect((await load()).plans?.overall.matched).toBe(0);
  });

  it("shares one workout across many plans", async () => {
    const [id] = await workouts(1);
    await t.db.scheduledWorkout.createMany({
      data: ["2026-06-01", "2026-06-02", "2026-06-03"].map((date, i) => ({
        workoutId: id as string,
        date,
        status: "published",
        externalId: `wristplan-s${i}`,
      })),
    });
    const o = (await load()).plans?.overall;
    expect(o).toMatchObject({ due: 3, excludedUnavailable: 0 });
  });
});

describe("loadDashboard input normalisation", () => {
  it.each([
    ["count outside the allowed set", { kind: "week", count: 5, anchor: TODAY }, "week", 8],
    ["zero count", { kind: "week", count: 0, anchor: TODAY }, "week", 8],
    ["fractional count", { kind: "month", count: 6.5, anchor: TODAY }, "month", 6],
    ["NaN count", { kind: "month", count: Number.NaN, anchor: TODAY }, "month", 6],
    ["month count valid for weeks only", { kind: "month", count: 4, anchor: TODAY }, "month", 6],
    ["junk kind", { kind: "" as never, count: 12, anchor: TODAY }, "week", 12],
    ["case-mismatched kind", { kind: "Month" as never, count: 3, anchor: TODAY }, "week", 8],
  ] as const)("falls back for %s", async (_n, p, kind, len) => {
    const d = await load(p);
    expect(d.periodSet.kind).toBe(kind);
    expect(d.periodSet.periods).toHaveLength(len);
  });

  it.each(["junk", "", "2026-02-30", "1969-12-31", "2101-01-01", "2026-6-1"])(
    "replaces anchor %j by today",
    async (anchor) => {
      const d = await load({ kind: "week", count: 4, anchor }, TODAY);
      expect(d.periodSet.to).toBe("2026-06-21");
    },
  );

  it("accepts the inclusive anchor bounds", async () => {
    expect((await load({ kind: "week", count: 4, anchor: "1970-01-01" })).periodSet.to).toBe(
      "1970-01-04",
    );
    const hi = await load({ kind: "week", count: 4, anchor: "2100-12-31" });
    expect(hi.periodSet.to).toBe("2101-01-02");
    expect(hi.partial).toBe(false);
  });
});

describe("loadDashboard shapes", () => {
  it("returns zeros and no notices for an empty database", async () => {
    const d = await load();
    expect(d).toMatchObject({
      notices: [],
      lastSync: null,
      activityCount: 0,
      planCount: 0,
      partial: false,
    });
    expect(d.volume.overall.count).toBe(0);
    expect(d.plans?.overall).toMatchObject({ due: 0, matched: 0, upcoming: 0, ratio: null });
  });

  it("handles plans without activities", async () => {
    await plan("2026-06-10");
    const d = await load();
    expect(d.plans?.overall).toMatchObject({ due: 1, matched: 0 });
    expect(d.volume.overall.count).toBe(0);
  });

  it("handles activities without plans", async () => {
    await activity("a", "2026-06-10T08:00:00Z");
    const d = await load();
    expect(d.plans?.overall).toMatchObject({ due: 0, matched: 0 });
    expect(d.volume.overall.count).toBe(1);
  });

  it("reports the most recent sync run", async () => {
    await t.db.syncRun.create({
      data: { startedAt: new Date("2026-06-10T08:00:00Z"), status: "failed", failed: 3 },
    });
    await t.db.syncRun.create({
      data: { startedAt: new Date("2026-06-16T09:30:00Z"), status: "success", imported: 5 },
    });
    expect((await load()).lastSync).toBe(
      "success (2026-06-16 09:30 UTC), 5 imported, 0 updated, 0 failed",
    );
  });

  it("counts a manual link only through the by-id fetch when the activity is far outside", async () => {
    await plan("2026-06-10", { matchSource: "manual", linkedGarminActivityId: "ancient" });
    await activity("ancient", "2020-01-01T00:00:00Z", { durationSeconds: 1234 });
    const d = await load();
    expect(d.plans?.overall).toMatchObject({ due: 1, matched: 1 });
    expect(d.plans?.overall.time.actualSeconds).toBe(1234);
    expect(d.activityCount).toBe(0);
    expect(d.volume.overall.count).toBe(0);
  });
});

describe("loadDashboard workout repository fallback", () => {
  it("resolves plans whose workout is beyond the repository list limit", async () => {
    const n = WORKOUT_LIST_LIMIT + 30;
    const ids = await workouts(n);
    await t.db.scheduledWorkout.createMany({
      data: ids.map((workoutId, i) => ({
        workoutId,
        date: addDays("2026-05-25", i % 28),
        status: "published",
        externalId: `wristplan-f${i}`,
      })),
    });
    const d = await load(week4, "2026-12-31");
    expect(d.planCount).toBe(n);
    expect(d.plans?.overall).toMatchObject({ due: n, excludedUnavailable: 0 });
  });

  it("still excludes a corrupt workout that is only reachable through the fallback", async () => {
    const ids = await workouts(WORKOUT_LIST_LIMIT + 5);
    await t.db.scheduledWorkout.createMany({
      data: ids.map((workoutId, i) => ({
        workoutId,
        date: addDays("2026-05-25", i % 28),
        status: "published",
        externalId: `wristplan-fc${i}`,
      })),
    });
    await t.db.workout.updateMany({ data: { definition: "{" }, where: { id: { in: ids } } });
    const d = await load(week4, "2026-12-31");
    expect(d.plans?.overall).toMatchObject({ due: 0, excludedUnavailable: ids.length });
  });
});

describe("loadDashboard caps", () => {
  it("is complete at exactly the activity cap", async () => {
    await manyActivities(DASHBOARD_ACTIVITY_LIMIT, "2026-06-01T00:00:00Z");
    const d = await load();
    expect(d.partial).toBe(false);
    expect(d.notices).toEqual([]);
    expect(d.activityCount).toBe(DASHBOARD_ACTIVITY_LIMIT);
    expect(d.plans).not.toBeNull();
    expect(d.trend).not.toBeNull();
  });

  it("flags one activity over the cap and drops the probe row from totals", async () => {
    await manyActivities(DASHBOARD_ACTIVITY_LIMIT + 1, "2026-06-01T00:00:00Z");
    const d = await load();
    expect(d.partial).toBe(true);
    expect(d.volume.overall.count).toBe(DASHBOARD_ACTIVITY_LIMIT);
    expect(d.notices).toHaveLength(1);
  });

  it("is complete at exactly the plan cap", async () => {
    await planGrid(SCHEDULE_LIST_LIMIT);
    const d = await load(week4, "2026-12-31");
    expect(d.partial).toBe(false);
    expect(d.notices).toEqual([]);
    expect(d.planCount).toBe(SCHEDULE_LIST_LIMIT);
    expect(d.plans?.overall.due).toBe(SCHEDULE_LIST_LIMIT);
  });

  it("flags one plan over the cap but keeps volume", async () => {
    await planGrid(SCHEDULE_LIST_LIMIT + 1);
    await activity("a", "2026-06-10T08:00:00Z");
    const d = await load(week4, "2026-12-31");
    expect(d.partial).toBe(true);
    expect(d.plans).toBeNull();
    expect(d.trend).not.toBeNull();
    expect(d.volume.overall.count).toBe(1);
  });

  it("reports both caps with one notice each when both overflow", async () => {
    await manyActivities(DASHBOARD_ACTIVITY_LIMIT + 1, "2026-06-01T00:00:00Z");
    await planGrid(SCHEDULE_LIST_LIMIT + 1);
    const d = await load();
    expect(d.partial).toBe(true);
    expect(d.notices).toEqual([
      "More than 2000 activities in this range; the oldest are omitted and totals are incomplete. Choose a shorter range.",
      "More than 500 scheduled workouts in this range; plan statistics are incomplete. Choose a shorter range.",
    ]);
    expect(d.plans).toBeNull();
    expect(d.trend).toBeNull();
  });
});

describe("loadDashboard data minimisation", () => {
  it("never selects the fit file and never returns blob content", async () => {
    const marker = "SYNTHETIC-FIT-MARKER";
    await t.db.activity.createMany({
      data: ["big1", "big2"].map((id, i) => ({
        garminActivityId: id,
        startTime: new Date(`2026-06-1${i}T08:00:00Z`),
        lastSyncedAt: new Date(0),
        sport: "running",
        fitFile: Buffer.from(marker.repeat(5000)),
      })),
    });
    await plan("2026-06-10", { matchSource: "manual", linkedGarminActivityId: "big1" });
    await plan("2026-06-11");
    await activity("out", "2020-01-01T00:00:00Z");
    const spy = vi.spyOn(t.db.activity, "findMany");
    const d = await load();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [args] of spy.mock.calls) {
      expect(args?.select).toBeDefined();
      expect(args?.select).not.toHaveProperty("fitFile");
      expect(args?.omit).toBeUndefined();
    }
    expect(JSON.stringify(d)).not.toContain(marker);
  });
});

describe("loadDashboard unavailable and mismatched plans", () => {
  it("excludes a plan whose workout row no longer exists", async () => {
    const id = await plan("2026-06-16");
    const row = await t.db.scheduledWorkout.findUniqueOrThrow({ where: { id } });
    // The FK restricts deletes, so simulate a dangling reference by disabling enforcement.
    await t.db.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
    await t.db.workout.delete({ where: { id: row.workoutId } });
    await activity("g1", "2026-06-16T08:00:00Z");
    const d = await load();
    expect(d.planCount).toBe(1);
    expect(d.plans?.overall).toMatchObject({ due: 0, matched: 0, excludedUnavailable: 1 });
  });

  it.each(["cycling", "trail_running", null])(
    "does not pair a run plan with a %s activity",
    async (sport) => {
      await plan("2026-06-16");
      await activity("g1", "2026-06-16T08:00:00Z", { sport });
      expect((await load()).plans?.overall).toMatchObject({ due: 1, matched: 0 });
    },
  );

  it("allows a manual link to an activity of another sport", async () => {
    await plan("2026-06-16", { matchSource: "manual", linkedGarminActivityId: "g1" });
    await activity("g1", "2026-06-16T08:00:00Z", { sport: "cycling" });
    expect((await load()).plans?.overall).toMatchObject({ due: 1, matched: 1 });
  });
});
