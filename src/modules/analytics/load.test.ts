import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createFakePublisher } from "../../../test/fake-publisher";
import {
  addDays,
  buildGrid,
  createScheduleService,
  loadCalendar,
  SCHEDULE_LIST_LIMIT,
} from "../calendar";
import { createWorkoutRepository } from "../workouts";
import { DASHBOARD_ACTIVITY_LIMIT, loadDashboard } from "./load";

const TODAY = "2026-06-17";
// 4 weeks: 2026-05-25 .. 2026-06-21
const params = { kind: "week", count: 4, anchor: TODAY } as const;
const timeStep = {
  kind: "work",
  end: { type: "time", seconds: 600 },
  target: { type: "hr", zone: 2 },
};

let t: TestDb;
let seq = 0;
const load = (p: Parameters<typeof loadDashboard>[1] = params, today = TODAY) =>
  loadDashboard(t.db, p, today);
const workout = async () =>
  (
    await createWorkoutRepository(t.db).create({
      name: `W${seq++}`,
      sport: "run",
      steps: [timeStep],
    })
  ).id;
const plan = async (date: string, extra: object = {}, workoutId?: string) =>
  (
    await t.db.scheduledWorkout.create({
      data: {
        workoutId: workoutId ?? (await workout()),
        date,
        status: "published",
        externalId: `wristplan-d${seq++}`,
        ...extra,
      },
    })
  ).id;
const activity = (id: string, startTime: string, extra: object = {}) =>
  t.db.activity.create({
    data: {
      garminActivityId: id,
      startTime: new Date(startTime),
      lastSyncedAt: new Date(),
      sport: "running",
      durationSeconds: 700,
      distanceMeters: 5000,
      ...extra,
    },
  });

beforeEach(() => {
  t = createTestDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  return t.cleanup();
});

describe("loadDashboard volume", () => {
  it("aggregates per sport and period from stored rows", async () => {
    await activity("a1", "2026-06-16T08:00:00Z");
    await activity("a2", "2026-06-10T08:00:00Z", { durationSeconds: null, distanceMeters: null });
    await activity("a3", "2026-06-11T08:00:00Z", { sport: "cycling", durationSeconds: 100 });
    await activity("out", "2026-05-24T23:59:59Z");
    await activity("out2", "2026-06-22T00:00:00Z");
    const d = await load();
    expect(d.periodSet.from).toBe("2026-05-25");
    expect(d.periodSet.to).toBe("2026-06-21");
    expect(d.activityCount).toBe(3);
    expect(d.partial).toBe(false);
    expect(d.volume.overall).toMatchObject({ count: 3, durationSeconds: 800, durationKnown: 2 });
    const running = d.volume.sports.find((s) => s.sport === "running");
    expect(running?.perPeriod[3]).toMatchObject({ count: 1, durationSeconds: 700 });
    expect(running?.perPeriod[2]).toMatchObject({ count: 1, durationKnown: 0, distanceKnown: 0 });
    expect(d.trend?.overall.points).toHaveLength(3);
  });

  it("re-normalises unparsed params", async () => {
    const d = await load({ kind: "year" as never, count: 5, anchor: "junk" });
    expect(d.periodSet.kind).toBe("week");
    expect(d.periodSet.periods).toHaveLength(8);
    expect(d.periodSet.periods[7]?.start).toBe("2026-06-15");
  });

  it("never selects the fit file", async () => {
    await t.db.activity.create({
      data: {
        garminActivityId: "big",
        startTime: new Date("2026-06-16T08:00:00Z"),
        lastSyncedAt: new Date(),
        fitFile: Buffer.alloc(50_000, 1),
      },
    });
    await plan("2026-06-16", { matchSource: "manual", linkedGarminActivityId: "big" });
    const spy = vi.spyOn(t.db.activity, "findMany");
    await load();
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [args] of spy.mock.calls) {
      expect(args?.select).toEqual({
        garminActivityId: true,
        sport: true,
        startTime: true,
        durationSeconds: true,
        distanceMeters: true,
      });
    }
  });

  it("reports the latest sync or null", async () => {
    expect((await load()).lastSync).toBeNull();
    await t.db.syncRun.create({
      data: { startedAt: new Date("2026-06-16T08:00:00Z"), status: "success", imported: 2 },
    });
    expect((await load()).lastSync).toBe(
      "success (2026-06-16 08:00 UTC), 2 imported, 0 updated, 0 failed",
    );
  });
});

describe("loadDashboard caps", () => {
  it("flags activity overflow, keeps volume and omits ratios and trends", async () => {
    const data = Array.from({ length: DASHBOARD_ACTIVITY_LIMIT + 1 }, (_, i) => ({
      garminActivityId: `c${i}`,
      startTime: new Date(Date.parse("2026-06-01T00:00:00Z") + i * 1000),
      lastSyncedAt: new Date(),
      sport: "running",
      durationSeconds: 1,
    }));
    await t.db.activity.createMany({ data });
    await plan("2026-06-02");
    const d = await load();
    expect(d.partial).toBe(true);
    expect(d.activityCount).toBe(DASHBOARD_ACTIVITY_LIMIT);
    expect(d.volume.overall.count).toBe(DASHBOARD_ACTIVITY_LIMIT);
    expect(d.plans).toBeNull();
    expect(d.trend).toBeNull();
    expect(d.notices).toEqual([
      "More than 2000 activities in this range; the oldest are omitted and totals are incomplete. Choose a shorter range.",
    ]);
  });

  it("keeps the newest rows and drops the single oldest", async () => {
    await t.db.activity.createMany({
      data: Array.from({ length: DASHBOARD_ACTIVITY_LIMIT + 1 }, (_, i) => ({
        garminActivityId: `n${i}`,
        startTime: new Date(Date.parse("2026-06-01T00:00:00Z") + i * 1000),
        lastSyncedAt: new Date(),
        sport: "running",
        durationSeconds: i === 0 ? 1000 : 1,
      })),
    });
    // n0 is the oldest: dropped from volume, still resolvable as a manual link
    await plan("2026-06-02", { matchSource: "manual", linkedGarminActivityId: "n0" });
    const spy = vi.spyOn(t.db.activity, "findMany");
    const d = await load();
    expect(d.activityCount).toBe(DASHBOARD_ACTIVITY_LIMIT);
    expect(d.volume.overall.count).toBe(DASHBOARD_ACTIVITY_LIMIT);
    expect(d.volume.overall.durationSeconds).toBe(DASHBOARD_ACTIVITY_LIMIT);
    expect(spy.mock.calls[0]?.[0]?.orderBy).toEqual({ startTime: "desc" });
    expect(d.plans).toBeNull();
  });

  it("flags plan overflow, keeps the trend and hides plans", async () => {
    // (workoutId, date) is unique: 19 workouts x 28 days covers the cap
    const ids = await Promise.all(Array.from({ length: 19 }, () => workout()));
    await t.db.scheduledWorkout.createMany({
      data: Array.from({ length: SCHEDULE_LIST_LIMIT + 1 }, (_, i) => ({
        workoutId: ids[Math.floor(i / 28)] ?? "",
        date: addDays("2026-05-25", i % 28),
        status: "published",
        externalId: `wristplan-cap${i}`,
      })),
    });
    const d = await load();
    expect(d.partial).toBe(true);
    expect(d.planCount).toBe(SCHEDULE_LIST_LIMIT);
    expect(d.plans).toBeNull();
    expect(d.trend).not.toBeNull();
    expect(d.notices).toEqual([
      "More than 500 scheduled workouts in this range; plan statistics are incomplete. Choose a shorter range.",
    ]);
  });
});

describe("loadDashboard plans", () => {
  it("matches automatically and compares planned with actual time", async () => {
    await plan("2026-06-08");
    await plan("2026-06-16");
    await activity("g1", "2026-06-16T08:00:00Z");
    const d = await load();
    expect(d.plans?.overall).toMatchObject({ due: 2, matched: 1, upcoming: 0 });
    expect(d.plans?.overall.time).toMatchObject({
      plannedSeconds: 600,
      actualSeconds: 700,
      pairsWithBoth: 1,
    });
    expect(d.plans?.perPeriod[3]?.due).toBe(1);
    expect(d.plans?.perPeriod[2]?.due).toBe(1);
  });

  it("resolves a manual cross-day link outside the range", async () => {
    await plan("2026-06-16", { matchSource: "manual", linkedGarminActivityId: "far" });
    await activity("far", "2026-04-01T08:00:00Z", { sport: "cycling", durationSeconds: 900 });
    const d = await load();
    expect(d.plans?.overall).toMatchObject({ due: 1, matched: 1 });
    expect(d.plans?.overall.time.actualSeconds).toBe(900);
    expect(d.volume.overall.count).toBe(0);
  });

  it("degrades a dangling link to auto", async () => {
    await plan("2026-06-16", { matchSource: "manual", linkedGarminActivityId: "ghost" });
    await activity("g1", "2026-06-16T08:00:00Z");
    expect((await load()).plans?.overall.matched).toBe(1);
  });

  it("excludes matchSource none and does not pair it", async () => {
    await plan("2026-06-16", { matchSource: "none" });
    await activity("g1", "2026-06-16T08:00:00Z");
    expect((await load()).plans?.overall).toMatchObject({
      due: 0,
      matched: 0,
      excludedNoMatch: 1,
    });
  });

  it("excludes plans with a corrupt workout", async () => {
    const corrupt = await workout();
    await t.db.workout.update({ where: { id: corrupt }, data: { definition: "{" } });
    await plan("2026-06-16", {}, corrupt);
    await activity("g1", "2026-06-16T08:00:00Z");
    expect((await load()).plans?.overall).toMatchObject({
      due: 0,
      matched: 0,
      excludedUnavailable: 1,
    });
  });

  it("ignores a link when the stored matchSource is odd", async () => {
    await plan("2026-06-16", { matchSource: "weird", linkedGarminActivityId: "far" });
    await activity("far", "2026-04-01T08:00:00Z");
    expect((await load()).plans?.overall).toMatchObject({ due: 1, matched: 0 });
  });

  it("counts future plans as upcoming", async () => {
    await plan("2026-06-18");
    await plan("2026-06-17");
    const d = await load();
    expect(d.plans?.overall).toMatchObject({ upcoming: 1, due: 1 });
  });
});

describe("loadDashboard parity with loadCalendar", () => {
  it("reports the same number of matched pairs", async () => {
    await plan("2026-06-15");
    await plan("2026-06-16", { matchSource: "manual", linkedGarminActivityId: "far" });
    await plan("2026-06-17", { matchSource: "manual", linkedGarminActivityId: "ghost" });
    await plan("2026-06-18", { matchSource: "none" });
    await plan("2026-06-19", { matchSource: "weird", linkedGarminActivityId: "g2" });
    await plan("2026-06-20");
    await activity("g1", "2026-06-15T08:00:00Z");
    await activity("far", "2026-05-01T08:00:00Z");
    await activity("g2", "2026-06-17T08:00:00Z");
    await activity("g3", "2026-06-19T08:00:00Z", { sport: "cycling" });
    await activity("g4", "2026-06-18T08:00:00Z");
    const cal = await loadCalendar(
      t.db,
      () =>
        createScheduleService({
          db: t.db,
          publisher: createFakePublisher(),
          now: () => new Date("2026-06-15T10:00:00Z"),
        }),
      buildGrid("week", TODAY),
      "2026-06-30",
    );
    const matched = Object.values(cal.days)
      .flatMap((d) => d.scheduled)
      .filter((s) => s.state === "matched").length;
    const d = await load(params, "2026-06-30");
    expect(matched).toBeGreaterThan(1);
    expect(d.plans?.overall.matched).toBe(matched);
  });
});
