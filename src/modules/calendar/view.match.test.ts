import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createFakePublisher } from "../../../test/fake-publisher";
import { ACTIVITY_LIST_LIMIT } from "../activities";
import { createWorkoutRepository } from "../workouts";
import { buildGrid } from "./grid";
import { createScheduleService } from "./schedule";
import { CANDIDATE_LIMIT, formatDelta, loadCalendar } from "./view";

const grid = buildGrid("week", "2026-06-17");
const TODAY = "2026-06-17";
const timeStep = {
  kind: "work",
  end: { type: "time", seconds: 600 },
  target: { type: "hr", zone: 2 },
};
const distStep = {
  kind: "work",
  end: { type: "distance", meters: 1000 },
  target: { type: "hr", zone: 2 },
};

let t: TestDb;
let seq = 0;
const monthGrid = buildGrid("month", "2026-06-17");
const load = (today = TODAY, g = grid) =>
  loadCalendar(
    t.db,
    () =>
      createScheduleService({
        db: t.db,
        publisher: createFakePublisher(),
        now: () => new Date("2026-06-15T10:00:00Z"),
      }),
    g,
    today,
  );
const workout = async (steps: object[] = [timeStep]) =>
  (await createWorkoutRepository(t.db).create({ name: `W${seq++}`, sport: "run", steps })).id;
const plan = async (date: string, extra: object = {}, workoutId?: string) =>
  (
    await t.db.scheduledWorkout.create({
      data: {
        workoutId: workoutId ?? (await workout()),
        date,
        status: "published",
        externalId: `wristplan-m${seq++}`,
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
const item = (data: Awaited<ReturnType<typeof load>>, date: string, i = 0) =>
  data.days[date]?.scheduled[i];

beforeEach(() => {
  t = createTestDb();
});
afterEach(() => t.cleanup());

describe("loadCalendar matching", () => {
  it("pairs a same-day run automatically and lists the activity once", async () => {
    await plan("2026-06-16");
    await activity("g1", "2026-06-16T08:00:00Z", { name: "Run" });
    const data = await load();
    expect(item(data, "2026-06-16")).toMatchObject({
      state: "matched",
      matchSource: null,
      linkMissing: false,
      match: {
        activityId: "g1",
        source: "auto",
        date: "2026-06-16",
        activity: { name: "Run", sport: "running", durationSeconds: 700, distanceMeters: 5000 },
        plannedSeconds: 600,
        deltaSeconds: 100,
      },
    });
    expect(data.days["2026-06-16"]?.activities).toEqual([]);
    expect(item(data, "2026-06-16")?.linkCandidates).toEqual([]);
  });

  it("leaves planned and delta null when either side is unknown", async () => {
    await plan("2026-06-16", {}, await workout([distStep, distStep]));
    await plan("2026-06-15");
    await activity("g1", "2026-06-16T08:00:00Z");
    await activity("g2", "2026-06-15T08:00:00Z", { durationSeconds: null });
    const data = await load();
    expect(item(data, "2026-06-16")?.match).toMatchObject({
      plannedSeconds: null,
      deltaSeconds: null,
    });
    expect(item(data, "2026-06-15")?.match).toMatchObject({
      plannedSeconds: 600,
      deltaSeconds: null,
    });
  });

  it("distinguishes planned from planned-not-done by today", async () => {
    await plan("2026-06-16");
    await plan("2026-06-17");
    await plan("2026-06-18");
    const data = await load();
    expect(item(data, "2026-06-16")?.state).toBe("missed");
    expect(item(data, "2026-06-17")?.state).toBe("planned");
    expect(item(data, "2026-06-18")?.state).toBe("planned");
  });

  it("shows an unplanned activity and offers it as a link candidate", async () => {
    await plan("2026-06-17");
    await activity("g1", "2026-06-16T08:00:00Z", { name: "Ride", sport: "cycling" });
    const data = await load();
    expect(data.days["2026-06-16"]?.activities.map((a) => a.id)).toEqual(["g1"]);
    expect(item(data, "2026-06-17")?.linkCandidates).toEqual([
      { id: "g1", label: "Ride, 2026-06-16, cycling" },
    ]);
  });

  it("renders a cross-day manual link in the plan's day even outside the grid", async () => {
    await plan("2026-06-16", { linkedGarminActivityId: "far", matchSource: "manual" });
    await activity("far", "2026-05-01T09:00:00Z", { sport: "cycling" });
    const data = await load();
    expect(item(data, "2026-06-16")).toMatchObject({
      state: "matched",
      matchSource: "manual",
      linkMissing: false,
      match: { activityId: "far", source: "manual", date: "2026-05-01" },
    });
    expect(Object.keys(data.days)).toEqual(["2026-06-16"]);
    expect(item(data, "2026-06-16")?.linkCandidates).toEqual([]);
  });

  it("keeps a manual link to an activity hidden by the activity cap", async () => {
    await t.db.activity.createMany({
      data: Array.from({ length: ACTIVITY_LIST_LIMIT }, (_, i) => ({
        garminActivityId: `a${i}`,
        startTime: new Date("2026-06-16T10:00:00Z"),
        lastSyncedAt: new Date(),
      })),
    });
    await activity("late", "2026-06-20T10:00:00Z");
    await plan("2026-06-19", { linkedGarminActivityId: "late", matchSource: "manual" });
    const data = await load();
    expect(item(data, "2026-06-19")?.match).toMatchObject({ activityId: "late", source: "manual" });
    expect(data.notices[0]).toContain("activities");
  });

  it("degrades a dangling manual link to auto and flags it", async () => {
    await plan("2026-06-16", { linkedGarminActivityId: "ghost", matchSource: "manual" });
    await plan("2026-06-15", { linkedGarminActivityId: "ghost2", matchSource: "manual" });
    await activity("g1", "2026-06-15T08:00:00Z");
    const data = await load();
    expect(item(data, "2026-06-16")).toMatchObject({
      state: "missed",
      linkMissing: true,
      match: null,
    });
    expect(item(data, "2026-06-15")).toMatchObject({
      linkMissing: true,
      match: { activityId: "g1", source: "auto" },
    });
  });

  it("honours 'none' by not pairing and keeping the activity unplanned", async () => {
    await plan("2026-06-18", { matchSource: "none" });
    await activity("g1", "2026-06-18T08:00:00Z");
    const data = await load();
    expect(item(data, "2026-06-18")).toMatchObject({
      state: "no-match",
      matchSource: "none",
      match: null,
    });
    expect(data.days["2026-06-18"]?.activities.map((a) => a.id)).toEqual(["g1"]);
  });

  it("ignores a link column when the stored matchSource is unknown", async () => {
    await plan("2026-06-16", { linkedGarminActivityId: "g9", matchSource: "weird" });
    await activity("g9", "2026-06-20T08:00:00Z", { sport: "cycling" });
    const data = await load();
    expect(item(data, "2026-06-16")).toMatchObject({
      state: "missed",
      matchSource: null,
      linkMissing: false,
      match: null,
    });
    expect(data.days["2026-06-20"]?.activities.map((a) => a.id)).toEqual(["g9"]);
  });

  it("treats a plan with a missing or corrupt workout as unmatched", async () => {
    await t.db.workout.create({ data: { id: "bad", definition: "{", isTemplate: false } });
    await plan("2026-06-16", {}, "bad");
    await activity("g1", "2026-06-16T08:00:00Z");
    const data = await load();
    expect(item(data, "2026-06-16")).toMatchObject({
      name: "Unavailable workout",
      state: "missed",
      match: null,
    });
    expect(data.days["2026-06-16"]?.activities.map((a) => a.id)).toEqual(["g1"]);
  });

  it("matches by UTC day at midnight", async () => {
    await plan("2026-06-16");
    await plan("2026-06-18");
    await activity("late", "2026-06-16T23:59:59.999Z");
    await activity("early", "2026-06-19T00:00:00.000Z");
    const data = await load();
    expect(item(data, "2026-06-16")?.match?.activityId).toBe("late");
    expect(item(data, "2026-06-18")?.match).toBeNull();
  });
});

describe("formatDelta", () => {
  it.each([
    [null, "n/a"],
    [100, "+1:40"],
    [-30, "-0:30"],
    [0, "0:00"],
    [Number.NaN, "n/a"],
    [Number.POSITIVE_INFINITY, "n/a"],
    [Number.NEGATIVE_INFINITY, "n/a"],
  ])("formats %s", (input, out) => {
    expect(formatDelta(input)).toBe(out);
  });
});

const day = (data: Awaited<ReturnType<typeof load>>, date: string) => data.days[date];
const created = (n: number) => ({ createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, n)) });

describe("loadCalendar matching: pairing rules", () => {
  it("gives a single same-day activity to the earliest-created plan only", async () => {
    const late = await plan("2026-06-16", created(20));
    const early = await plan("2026-06-16", created(10));
    await activity("g1", "2026-06-16T08:00:00Z");
    const data = await load();
    const byId = new Map(day(data, "2026-06-16")?.scheduled.map((s) => [s.id, s]));
    expect(byId.get(early)).toMatchObject({ state: "matched", match: { activityId: "g1" } });
    expect(byId.get(late)).toMatchObject({ state: "missed", match: null });
    expect(day(data, "2026-06-16")?.activities).toEqual([]);
  });

  it("pairs two same-day plans with two activities in creation and start order", async () => {
    const p1 = await plan("2026-06-16", created(1));
    const p2 = await plan("2026-06-16", created(2));
    await activity("later", "2026-06-16T18:00:00Z");
    await activity("sooner", "2026-06-16T06:00:00Z");
    const data = await load();
    const byId = new Map(day(data, "2026-06-16")?.scheduled.map((s) => [s.id, s]));
    expect(byId.get(p1)?.match?.activityId).toBe("sooner");
    expect(byId.get(p2)?.match?.activityId).toBe("later");
    expect(byId.get(p1)?.linkCandidates).toEqual([]);
  });

  it("lets a manual link win over an auto claim by an earlier plan on the activity's day", async () => {
    const autoPlan = await plan("2026-06-16", created(1));
    const linked = await plan("2026-06-18", {
      ...created(2),
      linkedGarminActivityId: "g1",
      matchSource: "manual",
    });
    await activity("g1", "2026-06-16T08:00:00Z");
    const data = await load();
    expect(item(data, "2026-06-18")).toMatchObject({
      id: linked,
      match: { activityId: "g1", source: "manual", date: "2026-06-16" },
    });
    expect(item(data, "2026-06-16")).toMatchObject({ id: autoPlan, state: "missed", match: null });
    expect(day(data, "2026-06-16")?.activities).toEqual([]);
  });

  it("falls the auto plan through to the next activity when a manual link takes the first", async () => {
    await plan("2026-06-16", created(1));
    await plan("2026-06-18", {
      ...created(2),
      linkedGarminActivityId: "g1",
      matchSource: "manual",
    });
    await activity("g1", "2026-06-16T08:00:00Z");
    await activity("g2", "2026-06-16T09:00:00Z");
    const data = await load();
    expect(item(data, "2026-06-16")?.match).toMatchObject({ activityId: "g2", source: "auto" });
    expect(item(data, "2026-06-18")?.match).toMatchObject({ activityId: "g1", source: "manual" });
  });

  it("frees the activity for another plan when one plan is marked no match", async () => {
    await plan("2026-06-16", { ...created(1), matchSource: "none" });
    await plan("2026-06-16", created(2), await workout());
    await activity("g1", "2026-06-16T08:00:00Z");
    const data = await load();
    const [first, second] = day(data, "2026-06-16")?.scheduled ?? [];
    expect(first).toMatchObject({ state: "no-match", match: null });
    expect(second).toMatchObject({ state: "matched", match: { activityId: "g1" } });
    expect(day(data, "2026-06-16")?.activities).toEqual([]);
  });

  it("keeps 'none' and offers the activity when a link column is also set", async () => {
    await plan("2026-06-16", { linkedGarminActivityId: "g1", matchSource: "none" });
    await activity("g1", "2026-06-16T08:00:00Z");
    const data = await load();
    expect(item(data, "2026-06-16")).toMatchObject({
      state: "no-match",
      matchSource: "none",
      linkMissing: false,
      match: null,
    });
    expect(item(data, "2026-06-16")?.linkCandidates.map((c) => c.id)).toEqual(["g1"]);
  });

  it("ignores a link on an unknown source and auto-pairs the earlier activity instead", async () => {
    const weird = await plan("2026-06-16", {
      linkedGarminActivityId: "g2",
      matchSource: "bogus",
    });
    await activity("g1", "2026-06-16T08:00:00Z");
    await activity("g2", "2026-06-16T09:00:00Z");
    const data = await load();
    expect(item(data, "2026-06-16")).toMatchObject({
      id: weird,
      matchSource: null,
      match: { activityId: "g1", source: "auto" },
    });
  });

  it("does not auto-match a different sport but allows a manual link to it", async () => {
    await plan("2026-06-16");
    await activity("ride", "2026-06-16T08:00:00Z", { sport: "cycling" });
    const before = await load();
    expect(item(before, "2026-06-16")?.match).toBeNull();
    await t.db.scheduledWorkout.updateMany({
      data: { linkedGarminActivityId: "ride", matchSource: "manual" },
    });
    const after = await load();
    expect(item(after, "2026-06-16")?.match).toMatchObject({
      activityId: "ride",
      source: "manual",
    });
  });

  it("matches the garmin activity id, not the row id, in manual and auto pairs", async () => {
    await plan("2026-06-16", created(1));
    await plan("2026-06-17", {
      ...created(2),
      linkedGarminActivityId: "gm",
      matchSource: "manual",
    });
    await activity("ga", "2026-06-16T08:00:00Z");
    await activity("gm", "2026-06-19T08:00:00Z");
    const rows = await t.db.activity.findMany({ select: { id: true } });
    const data = await load();
    const ids = [
      item(data, "2026-06-16")?.match?.activityId,
      item(data, "2026-06-17")?.match?.activityId,
    ];
    expect(ids).toEqual(["ga", "gm"]);
    for (const r of rows) expect(ids).not.toContain(r.id);
  });

  it("is deterministic for many plans and activities regardless of insertion order", async () => {
    const dates = ["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18"];
    const order = [7, 3, 11, 1, 9, 5, 0, 10, 2, 8, 4, 6];
    const planIds: string[] = [];
    for (const n of order) planIds[n] = await plan(dates[n % 4] as string, created(n));
    const acts = [11, 2, 7, 0, 5, 9, 1, 8, 3, 10, 4, 6];
    for (const n of acts) {
      await activity(
        `a${String(n).padStart(2, "0")}`,
        `${dates[n % 4]}T${String(6 + Math.floor(n / 4)).padStart(2, "0")}:00:00Z`,
      );
    }
    const first = await load();
    const second = await load();
    expect(second).toEqual(first);
    // plan n is the (n/4)th created on its day and gets the (n/4)th earliest activity of that day
    for (const n of order) {
      const s = day(first, dates[n % 4] as string)?.scheduled.find((x) => x.id === planIds[n]);
      expect(s?.match?.activityId).toBe(`a${String(n).padStart(2, "0")}`);
    }
    for (const d of dates) {
      for (const sch of day(first, d)?.scheduled ?? []) expect(sch.linkCandidates).toEqual([]);
    }
  });
});

describe("loadCalendar matching: manual links outside the visible set", () => {
  it("resolves a link to an in-range activity capped out of the list without listing it", async () => {
    await t.db.activity.createMany({
      data: Array.from({ length: ACTIVITY_LIST_LIMIT }, (_, i) => ({
        garminActivityId: `a${i}`,
        startTime: new Date("2026-06-16T10:00:00Z"),
        lastSyncedAt: new Date(),
        sport: "cycling",
      })),
    });
    await activity("capped", "2026-06-17T10:00:00Z", { sport: "cycling", name: "Capped" });
    await plan("2026-06-18", { linkedGarminActivityId: "capped", matchSource: "manual" });
    const data = await load();
    expect(item(data, "2026-06-18")).toMatchObject({
      state: "matched",
      linkMissing: false,
      match: { activityId: "capped", date: "2026-06-17" },
    });
    expect(day(data, "2026-06-17")).toBeUndefined();
    const ids = item(data, "2026-06-18")?.linkCandidates.map((c) => c.id) ?? [];
    expect(ids).not.toContain("capped");
    expect(ids).toHaveLength(CANDIDATE_LIMIT);
  });

  it("does not render an out-of-range linked activity as unplanned, nor as a candidate", async () => {
    await plan("2026-06-16", { linkedGarminActivityId: "far", matchSource: "manual" });
    await activity("far", "2026-07-30T09:00:00Z", { sport: "cycling" });
    await activity("other-far", "2026-07-30T10:00:00Z", { sport: "cycling" });
    const data = await load();
    expect(Object.keys(data.days)).toEqual(["2026-06-16"]);
    expect(item(data, "2026-06-16")?.linkCandidates).toEqual([]);
    expect(item(data, "2026-06-16")?.match?.date).toBe("2026-07-30");
  });

  it("does not let an out-of-range linked activity be auto-claimed by another plan", async () => {
    await plan("2026-06-16", { linkedGarminActivityId: "far", matchSource: "manual" });
    await plan("2026-06-17");
    await activity("far", "2026-06-17T09:00:00Z");
    const data = await load();
    expect(item(data, "2026-06-16")?.match?.activityId).toBe("far");
    expect(item(data, "2026-06-17")).toMatchObject({ state: "planned", match: null });
  });

  it("moves the activity between the grid and candidates when a link is switched", async () => {
    const p = await plan("2026-06-18");
    await activity("g1", "2026-06-16T08:00:00Z", { sport: "cycling" });
    await activity("g2", "2026-06-17T08:00:00Z", { sport: "cycling" });
    await t.db.scheduledWorkout.update({
      where: { id: p },
      data: { linkedGarminActivityId: "g1", matchSource: "manual" },
    });
    let data = await load();
    expect(item(data, "2026-06-18")?.match?.activityId).toBe("g1");
    expect(item(data, "2026-06-18")?.linkCandidates.map((c) => c.id)).toEqual(["g2"]);
    await t.db.scheduledWorkout.update({
      where: { id: p },
      data: { linkedGarminActivityId: "g2" },
    });
    data = await load();
    expect(item(data, "2026-06-18")?.match?.activityId).toBe("g2");
    expect(item(data, "2026-06-18")?.linkCandidates.map((c) => c.id)).toEqual(["g1"]);
    expect(day(data, "2026-06-16")?.activities.map((a) => a.id)).toEqual(["g1"]);
    expect(day(data, "2026-06-17")).toBeUndefined();
  });

  it("flags a dangling link and offers a plan-less activity as candidate", async () => {
    await plan("2026-06-16", { linkedGarminActivityId: "ghost", matchSource: "manual" });
    await activity("g1", "2026-06-16T08:00:00Z", { sport: "cycling" });
    const data = await load();
    expect(item(data, "2026-06-16")).toMatchObject({ linkMissing: true, match: null });
    expect(item(data, "2026-06-16")?.linkCandidates.map((c) => c.id)).toEqual(["g1"]);
  });

  it("never passes a plan with a corrupt workout to the matcher, even with a manual link", async () => {
    await t.db.workout.create({ data: { id: "bad", definition: "{", isTemplate: false } });
    await plan(
      "2026-06-16",
      { ...created(1), linkedGarminActivityId: "g1", matchSource: "manual" },
      "bad",
    );
    await plan("2026-06-16", created(2));
    await activity("g1", "2026-06-16T08:00:00Z");
    const data = await load();
    const [bad, good] = day(data, "2026-06-16")?.scheduled ?? [];
    expect(bad).toMatchObject({ name: "Unavailable workout", state: "missed", match: null });
    expect(good).toMatchObject({ state: "matched", match: { activityId: "g1", source: "auto" } });
  });

  it("does not let a corrupt-workout plan consume a same-day activity", async () => {
    await t.db.workout.create({ data: { id: "bad", definition: "{", isTemplate: false } });
    await plan("2026-06-16", created(1), "bad");
    await plan("2026-06-16", created(2));
    await activity("g1", "2026-06-16T08:00:00Z");
    const data = await load();
    const good = day(data, "2026-06-16")?.scheduled.find((s) => s.name !== "Unavailable workout");
    expect(good?.match?.activityId).toBe("g1");
  });
});

describe("loadCalendar matching: day boundaries", () => {
  it("buckets by UTC day on both sides of midnight", async () => {
    await plan("2026-06-16", created(1));
    await plan("2026-06-17", created(2));
    await activity("a", "2026-06-16T23:59:59.999Z");
    await activity("b", "2026-06-17T00:00:00.000Z");
    const data = await load();
    expect(item(data, "2026-06-16")?.match?.activityId).toBe("a");
    expect(item(data, "2026-06-17")?.match?.activityId).toBe("b");
  });

  it("treats the date equal to today as planned and the day before as missed", async () => {
    await plan("2026-06-16");
    await plan("2026-06-17");
    const data = await load("2026-06-17");
    expect(item(data, "2026-06-16")?.state).toBe("missed");
    expect(item(data, "2026-06-17")?.state).toBe("planned");
    const later = await load("2026-06-18");
    expect(item(later, "2026-06-17")?.state).toBe("missed");
  });

  it("prefers matched over missed for a past plan, and no-match over missed", async () => {
    await plan("2026-06-15", created(1));
    await plan("2026-06-16", { matchSource: "none" });
    await activity("g1", "2026-06-15T08:00:00Z");
    const data = await load("2026-06-20");
    expect(item(data, "2026-06-15")?.state).toBe("matched");
    expect(item(data, "2026-06-16")?.state).toBe("no-match");
  });
});

describe("loadCalendar link candidates", () => {
  const ids = (data: Awaited<ReturnType<typeof load>>, date: string) =>
    item(data, date)?.linkCandidates.map((c) => c.id);

  it("lists only unpaired nearby activities with day and sport", async () => {
    await plan("2026-06-16");
    await activity("paired", "2026-06-16T07:00:00Z");
    await activity("b", "2026-06-18T07:00:00Z", { name: "B", sport: "cycling" });
    await activity("a", "2026-06-17T07:00:00Z", { name: "A", sport: "swimming" });
    await activity("out", "2026-06-30T07:00:00Z", { name: "Out" });
    const data = await load(TODAY, monthGrid);
    expect(item(data, "2026-06-16")?.linkCandidates).toEqual([
      { id: "a", label: "A, 2026-06-17, swimming" },
      { id: "b", label: "B, 2026-06-18, cycling" },
    ]);
  });

  it("includes the +/-7 day edges and excludes 8 days away", async () => {
    await plan("2026-06-17");
    await activity("m7", "2026-06-10T00:00:00.000Z", { sport: "cycling" });
    await activity("m8", "2026-06-09T23:59:59.999Z", { sport: "cycling" });
    await activity("p7", "2026-06-24T23:59:59.999Z", { sport: "cycling" });
    await activity("p8", "2026-06-25T00:00:00.000Z", { sport: "cycling" });
    const data = await load(TODAY, monthGrid);
    expect(ids(data, "2026-06-17")).toEqual(["m7", "p7"]);
  });

  it("orders by day distance, then start time, then id", async () => {
    await plan("2026-06-17");
    await activity("z-early", "2026-06-17T05:00:00Z", { sport: "cycling" });
    await activity("b-late", "2026-06-17T09:00:00Z", { sport: "cycling" });
    await activity("a-late", "2026-06-17T09:00:00Z", { sport: "cycling" });
    await activity("next", "2026-06-18T01:00:00Z", { sport: "cycling" });
    await activity("prev", "2026-06-16T23:00:00Z", { sport: "cycling" });
    await activity("far", "2026-06-20T01:00:00Z", { sport: "cycling" });
    const data = await load();
    expect(ids(data, "2026-06-17")).toEqual(["z-early", "a-late", "b-late", "prev", "next", "far"]);
  });

  it("caps the list at 25, keeping the nearest", async () => {
    await plan("2026-06-17");
    await t.db.activity.createMany({
      data: Array.from({ length: 40 }, (_, i) => ({
        garminActivityId: `n${String(i).padStart(2, "0")}`,
        startTime: new Date(Date.UTC(2026, 5, 17, 0, i)),
        lastSyncedAt: new Date(),
        sport: "cycling",
      })),
    });
    await activity("next-day", "2026-06-18T00:00:00Z", { sport: "cycling" });
    const data = await load();
    const got = ids(data, "2026-06-17") ?? [];
    expect(got).toHaveLength(CANDIDATE_LIMIT);
    expect(got[0]).toBe("n00");
    expect(got[24]).toBe("n24");
  });

  it("is empty with no nearby unpaired activities", async () => {
    await plan("2026-06-17");
    const data = await load();
    expect(ids(data, "2026-06-17")).toEqual([]);
  });

  it("gives a manually linked item candidates excluding its own activity", async () => {
    await plan("2026-06-17", { linkedGarminActivityId: "mine", matchSource: "manual" });
    await activity("mine", "2026-06-17T08:00:00Z", { sport: "cycling" });
    await activity("other", "2026-06-17T09:00:00Z", { sport: "cycling" });
    const data = await load();
    expect(item(data, "2026-06-17")?.match?.activityId).toBe("mine");
    expect(ids(data, "2026-06-17")).toEqual(["other"]);
  });

  it("keeps hostile activity text as inert data and uses the fallback for empty names", async () => {
    const hostile = `<img src=x onerror=alert(1)> & "q" 'x' </option><script>`;
    await plan("2026-06-17");
    await activity("g1", "2026-06-16T08:00:00Z", { name: hostile, sport: "cycling" });
    await activity("g2", "2026-06-17T08:00:00Z", { name: "", sport: "cycling" });
    const data = await load();
    const list = item(data, "2026-06-17")?.linkCandidates ?? [];
    expect(list[0]?.id).toBe("g2");
    expect(list[0]?.label).not.toMatch(/^,/);
    expect(list[1]).toEqual({ id: "g1", label: `${hostile}, 2026-06-16, cycling` });
    expect(day(data, "2026-06-16")?.activities[0]?.name).toBe(hostile);
  });
});

describe("formatDelta edge cases", () => {
  it.each([
    [0, "0:00"],
    [59, "+0:59"],
    [60, "+1:00"],
    [-60, "-1:00"],
    [3599, "+59:59"],
    [3600, "+1:00:00"],
    [3661, "+1:01:01"],
    [-3661, "-1:01:01"],
    [360000, "+100:00:00"],
    [0.4, "0:00"],
    [-0.4, "0:00"],
    [-0, "0:00"],
    [1.5, "+0:02"],
    [-1.5, "-0:02"],
  ])("formats %s as %s", (input, out) => {
    expect(formatDelta(input)).toBe(out);
  });
});
