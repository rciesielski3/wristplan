import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createFakePublisher } from "../../../test/fake-publisher";
import { ACTIVITY_LIST_LIMIT } from "../activities";
import { createWorkoutRepository, WORKOUT_LIST_LIMIT } from "../workouts";
import { ScheduleListOverflowError, ScheduleValidationError } from "./errors";
import { buildGrid } from "./grid";
import { createScheduleService, SCHEDULE_LIST_LIMIT } from "./schedule";
import { loadCalendar } from "./view";

const input = (name: string, sport = "run") => ({
  name,
  sport,
  steps: [{ kind: "work", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 2 } }],
});
const grid = buildGrid("week", "2026-06-17");

let t: TestDb;
const service = () =>
  createScheduleService({
    db: t.db,
    publisher: createFakePublisher(),
    now: () => new Date("2026-06-15T10:00:00Z"),
  });
const activity = (id: string, startTime: string, extra: object = {}) =>
  t.db.activity.create({
    data: {
      garminActivityId: id,
      startTime: new Date(startTime),
      lastSyncedAt: new Date(),
      ...extra,
    },
  });

beforeEach(() => {
  t = createTestDb();
});
afterEach(() => t.cleanup());

describe("loadCalendar", () => {
  it("merges scheduled workouts and activities per day", async () => {
    const repo = createWorkoutRepository(t.db);
    const w = await repo.create(input("Easy run"));
    const tpl = await repo.create(input("Tpl"), { isTemplate: true });
    const row = await t.db.scheduledWorkout.create({
      data: {
        workoutId: w.id,
        date: "2026-06-16",
        status: "failed",
        externalId: "wristplan-x",
        lastError: "PublisherAuthError (401)",
      },
    });
    await activity("g1", "2026-06-16T23:30:00Z", {
      name: "Morning",
      sport: "running",
      durationSeconds: 1800,
      distanceMeters: 5000,
    });
    await activity("g2", "2026-06-14T10:00:00Z");
    await activity("g3", "2026-06-22T00:00:00Z");
    await activity("g4", "2026-06-21T23:59:59Z");

    const data = await loadCalendar(t.db, () => service(), grid);

    expect(data.notices).toEqual([]);
    expect(data.days["2026-06-16"]?.scheduled).toEqual([
      {
        id: row.id,
        date: "2026-06-16",
        name: "Easy run",
        summary: "run, 1 step, 10:00",
        status: "failed",
        lastError: "PublisherAuthError (401)",
      },
    ]);
    expect(data.days["2026-06-16"]?.activities).toEqual([
      { id: "g1", name: "Morning", sport: "running", duration: "30:00", distance: "5.00 km" },
    ]);
    expect(Object.keys(data.days).sort()).toEqual(["2026-06-16", "2026-06-21"]);
    expect(data.workouts).toEqual(
      expect.arrayContaining([
        { id: w.id, label: "Easy run" },
        { id: tpl.id, label: "Tpl (template)" },
      ]),
    );
  });

  it("shows a placeholder when the workout cannot be read", async () => {
    await t.db.workout.create({ data: { id: "bad", definition: "{", isTemplate: false } });
    await t.db.scheduledWorkout.create({
      data: { workoutId: "bad", date: "2026-06-16", status: "pending", externalId: "wristplan-y" },
    });
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(data.days["2026-06-16"]?.scheduled[0]).toMatchObject({
      name: "Unavailable workout",
      summary: "",
    });
  });

  it("reports a schedule overflow as a notice and keeps activities", async () => {
    await activity("g1", "2026-06-16T10:00:00Z");
    const overflowing = () =>
      ({
        list: () => Promise.reject(new ScheduleListOverflowError()),
      }) as unknown as ReturnType<typeof service>;
    const data = await loadCalendar(t.db, overflowing, grid);
    expect(data.notices[0]).toContain(String(SCHEDULE_LIST_LIMIT));
    expect(data.days["2026-06-16"]?.activities).toHaveLength(1);
  });

  it("rethrows unexpected schedule errors", async () => {
    const broken = () =>
      ({ list: () => Promise.reject(new Error("db down")) }) as unknown as ReturnType<
        typeof service
      >;
    await expect(loadCalendar(t.db, broken, grid)).rejects.toThrow("db down");
  });

  it("fetches workouts without a total duration summary", async () => {
    const repo = createWorkoutRepository(t.db);
    const w = await repo.create({
      name: "Open",
      sport: "run",
      steps: [
        { kind: "work", end: { type: "distance", meters: 1000 }, target: { type: "hr", zone: 2 } },
        { kind: "work", end: { type: "distance", meters: 1000 }, target: { type: "hr", zone: 2 } },
      ],
    });
    await t.db.scheduledWorkout.create({
      data: { workoutId: w.id, date: "2026-06-16", status: "published", externalId: "wristplan-z" },
    });
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(data.days["2026-06-16"]?.scheduled[0]?.summary).toBe("run, 2 steps");
  });

  it("looks up scheduled workouts beyond the dropdown list limit", async () => {
    const repo = createWorkoutRepository(t.db);
    const old = await repo.create(input("Old one"));
    await t.db.workout.update({
      where: { id: old.id },
      data: { updatedAt: new Date("2000-01-01") },
    });
    const definition = JSON.stringify(input("Filler"));
    await t.db.workout.createMany({
      data: Array.from({ length: WORKOUT_LIST_LIMIT }, (_, i) => ({
        id: `f${i}`,
        definition,
        isTemplate: false,
      })),
    });
    await t.db.scheduledWorkout.create({
      data: { workoutId: old.id, date: "2026-06-16", status: "pending", externalId: "wristplan-q" },
    });
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(data.days["2026-06-16"]?.scheduled[0]?.name).toBe("Old one");
  });

  it("caps activities and says so", async () => {
    await t.db.activity.createMany({
      data: Array.from({ length: ACTIVITY_LIST_LIMIT + 1 }, (_, i) => ({
        garminActivityId: `a${i}`,
        startTime: new Date("2026-06-16T10:00:00Z"),
        lastSyncedAt: new Date(),
      })),
    });
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(data.days["2026-06-16"]?.activities).toHaveLength(ACTIVITY_LIST_LIMIT);
    expect(data.notices[0]).toContain("activities");
  });
});

describe("loadCalendar boundaries and degradation", () => {
  const fakeList = (rows: unknown[]) =>
    (() => ({ list: () => Promise.resolve(rows) })) as unknown as () => ReturnType<typeof service>;
  const row = (id: string, workoutId: string, date: string) => ({
    id,
    workoutId,
    date,
    status: "pending",
    lastError: null,
  });

  it("includes activities exactly at 00:00Z of the first day and the last millisecond of the last day", async () => {
    await activity("first", "2026-06-15T00:00:00.000Z");
    await activity("last", "2026-06-21T23:59:59.999Z");
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(data.days["2026-06-15"]?.activities.map((a) => a.id)).toEqual(["first"]);
    expect(data.days["2026-06-21"]?.activities.map((a) => a.id)).toEqual(["last"]);
  });

  it("excludes activities one millisecond before the range and exactly at to+1 00:00Z", async () => {
    await activity("before", "2026-06-14T23:59:59.999Z");
    await activity("after", "2026-06-22T00:00:00.000Z");
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(data.days).toEqual({});
  });

  it("buckets activities by UTC day around midnight", async () => {
    await activity("late", "2026-06-16T23:59:59.999Z");
    await activity("early", "2026-06-17T00:00:00.000Z");
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(data.days["2026-06-16"]?.activities.map((a) => a.id)).toEqual(["late"]);
    expect(data.days["2026-06-17"]?.activities.map((a) => a.id)).toEqual(["early"]);
  });

  it("buckets identically under a non-UTC process timezone", async () => {
    const original = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      await activity("late", "2026-06-16T23:30:00.000Z");
      const data = await loadCalendar(t.db, () => service(), grid);
      expect(Object.keys(data.days)).toEqual(["2026-06-16"]);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("covers the whole padded month grid, including neighbouring-month days", async () => {
    const month = buildGrid("month", "2026-06-17");
    await activity("lead", "2026-06-01T00:00:00Z");
    await activity("trail", "2026-07-05T23:00:00Z");
    await activity("outside", "2026-07-06T00:00:00Z");
    const data = await loadCalendar(t.db, () => service(), month);
    expect(Object.keys(data.days).sort()).toEqual(["2026-06-01", "2026-07-05"]);
  });

  it("orders activities within a day by start time", async () => {
    await activity("b", "2026-06-16T12:00:00Z");
    await activity("a", "2026-06-16T06:00:00Z");
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(data.days["2026-06-16"]?.activities.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("excludes scheduled rows outside the range", async () => {
    const w = await createWorkoutRepository(t.db).create(input("Run"));
    for (const [i, date] of ["2026-06-14", "2026-06-22", "2026-06-15", "2026-06-21"].entries()) {
      await t.db.scheduledWorkout.create({
        data: { workoutId: w.id, date, status: "pending", externalId: `wristplan-r${i}` },
      });
    }
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(Object.keys(data.days).sort()).toEqual(["2026-06-15", "2026-06-21"]);
  });

  it("reports an overflow from the real service and still shows activities", async () => {
    const definition = JSON.stringify(input("Run"));
    const workoutIds = Array.from({ length: 72 }, (_, i) => `ov${i}`);
    await t.db.workout.createMany({
      data: workoutIds.map((id) => ({ id, definition, isTemplate: false })),
    });
    // 72 workouts x 7 days = 504 rows, one more than the limit allows
    await t.db.scheduledWorkout.createMany({
      data: workoutIds.flatMap(
        (workoutId, i) =>
          grid.weeks[0]?.map((date, d) => ({
            workoutId,
            date,
            status: "pending",
            externalId: `wristplan-o${i}-${d}`,
          })) ?? [],
      ),
    });
    await activity("g1", "2026-06-16T10:00:00Z");
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(data.notices).toHaveLength(1);
    expect(data.notices[0]).toContain(`More than ${SCHEDULE_LIST_LIMIT} scheduled`);
    expect(data.days["2026-06-16"]?.scheduled).toEqual([]);
    expect(data.days["2026-06-16"]?.activities).toHaveLength(1);
  });

  it("emits both notices when schedule and activities overflow", async () => {
    await t.db.activity.createMany({
      data: Array.from({ length: ACTIVITY_LIST_LIMIT + 1 }, (_, i) => ({
        garminActivityId: `a${i}`,
        startTime: new Date("2026-06-16T10:00:00Z"),
        lastSyncedAt: new Date(),
      })),
    });
    const overflowing = () =>
      ({
        list: () => Promise.reject(new ScheduleListOverflowError()),
      }) as unknown as ReturnType<typeof service>;
    const data = await loadCalendar(t.db, overflowing, grid);
    expect(data.notices).toHaveLength(2);
  });

  it("does not add an activity notice at exactly the limit", async () => {
    await t.db.activity.createMany({
      data: Array.from({ length: ACTIVITY_LIST_LIMIT }, (_, i) => ({
        garminActivityId: `a${i}`,
        startTime: new Date("2026-06-16T10:00:00Z"),
        lastSyncedAt: new Date(),
      })),
    });
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(data.days["2026-06-16"]?.activities).toHaveLength(ACTIVITY_LIST_LIMIT);
    expect(data.notices).toEqual([]);
  });

  it("keeps the earliest activities when capped", async () => {
    await t.db.activity.createMany({
      data: Array.from({ length: ACTIVITY_LIST_LIMIT }, (_, i) => ({
        garminActivityId: `a${i}`,
        startTime: new Date("2026-06-16T10:00:00Z"),
        lastSyncedAt: new Date(),
      })),
    });
    await activity("latest", "2026-06-20T10:00:00Z");
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(data.days["2026-06-20"]).toBeUndefined();
    expect(data.notices[0]).toContain("activities");
  });

  it.each([
    ["validation error", new ScheduleValidationError("from must not be after to")],
    ["non-Error rejection", "boom"],
  ])("propagates a %s from the schedule list", async (_n, err) => {
    const broken = () =>
      ({ list: () => Promise.reject(err) }) as unknown as ReturnType<typeof service>;
    await expect(loadCalendar(t.db, broken, grid)).rejects.toBe(err);
  });

  it("shows 'Unavailable workout' for a row whose workout does not exist", async () => {
    const data = await loadCalendar(t.db, fakeList([row("s1", "ghost", "2026-06-16")]), grid);
    expect(data.days["2026-06-16"]?.scheduled[0]).toMatchObject({
      id: "s1",
      name: "Unavailable workout",
      summary: "",
      status: "pending",
    });
  });

  it("keeps rows for resolvable and unavailable workouts side by side", async () => {
    const w = await createWorkoutRepository(t.db).create(input("Good"));
    const data = await loadCalendar(
      t.db,
      fakeList([row("s1", "ghost", "2026-06-16"), row("s2", w.id, "2026-06-16")]),
      grid,
    );
    expect(data.days["2026-06-16"]?.scheduled.map((s) => s.name)).toEqual([
      "Unavailable workout",
      "Good",
    ]);
  });

  it("returns empty data for an empty database", async () => {
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(data).toEqual({ days: {}, workouts: [], notices: [] });
  });

  it("pluralises single-step workouts and never leaks error details into names", async () => {
    await t.db.workout.create({ data: { id: "bad", definition: "{secret", isTemplate: false } });
    await t.db.scheduledWorkout.create({
      data: { workoutId: "bad", date: "2026-06-16", status: "failed", externalId: "wristplan-b" },
    });
    const data = await loadCalendar(t.db, () => service(), grid);
    expect(JSON.stringify(data)).not.toContain("secret");
  });
});
