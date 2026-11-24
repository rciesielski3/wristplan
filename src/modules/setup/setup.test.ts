import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, migrate, type TestDb } from "../../../test/db-helpers";
import { createDb } from "../../lib/db";
import {
  buildChecklist,
  buildSidebarView,
  getSetupStatus,
  loadSetupCounts,
  NOT_READY,
  type SetupCounts,
} from "./index";

const READY: SetupCounts = {
  databaseReady: true,
  activityCount: 0,
  workoutCount: 0,
  scheduledCount: 0,
  lastSync: null,
};
const KEYS = { GARMIN_PERSONAL_API_KEY: "fake-garmin", INTERVALS_API_KEY: "fake-intervals" };
const states = (c: SetupCounts, env = {}) =>
  buildChecklist(getSetupStatus(env, c)).steps.map((s) => s.state);

describe("getSetupStatus", () => {
  it("reports key presence as booleans; blank and whitespace count as missing", () => {
    expect(getSetupStatus(KEYS, READY)).toMatchObject({
      garminKeyConfigured: true,
      intervalsKeyConfigured: true,
    });
    expect(
      getSetupStatus({ GARMIN_PERSONAL_API_KEY: "  ", INTERVALS_API_KEY: "" }, READY),
    ).toMatchObject({
      garminKeyConfigured: false,
      intervalsKeyConfigured: false,
    });
    expect(getSetupStatus({}, READY).garminKeyConfigured).toBe(false);
  });

  it("copies counts and last sync", () => {
    const startedAt = new Date("2026-06-01T10:00:00Z");
    const s = getSetupStatus(
      {},
      { ...READY, activityCount: 3, lastSync: { status: "succeeded", startedAt } },
    );
    expect(s.activityCount).toBe(3);
    expect(s.lastSync).toEqual({ status: "succeeded", startedAt });
  });

  it("never lets key values into the status, checklist or sidebar view", () => {
    const env = { GARMIN_PERSONAL_API_KEY: "zzqq-gk-0000", INTERVALS_API_KEY: "zzqq-ik-1111" };
    const status = getSetupStatus(env, READY);
    const out = JSON.stringify([status, buildChecklist(status), buildSidebarView(status)]);
    for (const secret of Object.values(env)) {
      expect(out).not.toContain(secret);
      expect(out).not.toContain("zzqq");
    }
  });
});

describe("buildChecklist", () => {
  it("empty migrated database with no keys: 1 of 6", () => {
    const v = buildChecklist(getSetupStatus({}, READY));
    expect(v.progress).toBe("1 of 6");
    expect(v.complete).toBe(false);
    expect(v.steps.map((s) => s.state)).toEqual([
      "done",
      "todo",
      "todo",
      "blocked",
      "todo",
      "blocked",
    ]);
    expect(v.steps[3]?.hint).toContain("Garmin key");
    expect(v.steps[5]?.hint).toContain("first workout");
    expect(v.steps[1]?.hint).toMatch(/\.env.*README/);
  });

  it("unmigrated database blocks every data step", () => {
    expect(states(NOT_READY)).toEqual(["todo", "todo", "todo", "blocked", "blocked", "blocked"]);
    expect(buildChecklist(getSetupStatus({}, NOT_READY)).steps[3]?.hint).toContain("database");
  });

  it("everything configured and used is complete", () => {
    const v = buildChecklist(
      getSetupStatus(KEYS, { ...READY, activityCount: 1, workoutCount: 1, scheduledCount: 1 }),
    );
    expect(v.progress).toBe("6 of 6");
    expect(v.complete).toBe(true);
    expect(v.steps.every((s) => s.state === "done" && s.href === null)).toBe(true);
  });

  it.each([
    ["no scheduled workout", { scheduledCount: 0, workoutCount: 1, activityCount: 1 }],
    ["no workout", { scheduledCount: 1, workoutCount: 0, activityCount: 1 }],
    ["no synced activity", { scheduledCount: 1, workoutCount: 1, activityCount: 0 }],
  ])("is not complete with %s even when the rest is done", (_name, counts) => {
    const v = buildChecklist(getSetupStatus(KEYS, { ...READY, ...counts }));
    expect(v.progress).toBe("5 of 6");
    expect(v.complete).toBe(false);
  });

  it("is not complete when one key is missing", () => {
    const counts = { ...READY, activityCount: 1, workoutCount: 1, scheduledCount: 1 };
    const v = buildChecklist(getSetupStatus({ GARMIN_PERSONAL_API_KEY: "x" }, counts));
    expect(v.progress).toBe("5 of 6");
    expect(v.complete).toBe(false);
  });

  it("unblocks sync with a key and scheduling with workout plus intervals key", () => {
    expect(states(READY, { GARMIN_PERSONAL_API_KEY: "x" })[3]).toBe("todo");
    const withWorkout = { ...READY, workoutCount: 1 };
    expect(states(withWorkout)[5]).toBe("blocked");
    expect(buildChecklist(getSetupStatus({}, withWorkout)).steps[5]?.hint).toContain(
      "intervals.icu key",
    );
    expect(states(withWorkout, { INTERVALS_API_KEY: "x" })[5]).toBe("todo");
  });

  it("links the workout and calendar steps", () => {
    const steps = buildChecklist(getSetupStatus(KEYS, { ...READY, workoutCount: 1 })).steps;
    expect(steps[4]?.state).toBe("done");
    expect(steps[5]?.href).toBe("/calendar");
    expect(buildChecklist(getSetupStatus(KEYS, READY)).steps[4]?.href).toBe("/workouts/new");
  });
});

describe("buildSidebarView", () => {
  it("flags missing items with text and shows last sync", () => {
    const v = buildSidebarView(getSetupStatus({ GARMIN_PERSONAL_API_KEY: "x" }, NOT_READY));
    expect(v.lines).toEqual([
      { label: "Database", ok: false, text: "Not migrated" },
      { label: "Garmin key", ok: true, text: "Added" },
      { label: "intervals.icu key", ok: false, text: "Missing" },
    ]);
    expect(v.needsSetup).toBe(true);
    expect(v.lastSync).toBe("Latest sync: never");
  });

  it("is quiet when all is configured", () => {
    const startedAt = new Date("2026-06-01T10:00:00Z");
    const v = buildSidebarView(
      getSetupStatus(KEYS, { ...READY, lastSync: { status: "failed", startedAt } }),
    );
    expect(v.needsSetup).toBe(false);
    expect(v.lines.every((l) => l.ok)).toBe(true);
    expect(v.lastSync).toBe("Latest sync: failed, 2026-06-01 10:00 UTC");
  });
});

describe("loadSetupCounts", () => {
  let t: TestDb | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await t?.cleanup();
    t = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("counts an empty migrated database as ready", async () => {
    t = createTestDb();
    expect(await loadSetupCounts(t.db)).toEqual(READY);
  });

  it("counts rows, ignores templates and returns the latest sync", async () => {
    t = createTestDb();
    const { db } = t;
    await db.workout.create({ data: { id: "w1", definition: "{}", isTemplate: false } });
    await db.workout.create({ data: { id: "w2", definition: "{}", isTemplate: true } });
    await db.scheduledWorkout.create({
      data: { workoutId: "w1", date: "2026-06-01", status: "pending", externalId: "wristplan-1" },
    });
    await db.activity.create({
      data: {
        garminActivityId: "9",
        startTime: new Date("2026-06-01T07:00:00Z"),
        lastSyncedAt: new Date("2026-06-01T08:00:00Z"),
      },
    });
    const startedAt = new Date("2026-06-02T07:00:00Z");
    await db.syncRun.create({ data: { startedAt, status: "succeeded" } });
    expect(await loadSetupCounts(db)).toEqual({
      databaseReady: true,
      activityCount: 1,
      workoutCount: 1,
      scheduledCount: 1,
      lastSync: { status: "succeeded", startedAt },
    });
  });

  it("reports a database without the link migration as not ready", async () => {
    dir = mkdtempSync(join(tmpdir(), "wristplan-setup-"));
    const file = join(dir, "old.db");
    migrate(file, "20261118140000_workout_schedule");
    const db = createDb(`file:${file}`);
    try {
      expect(await loadSetupCounts(db)).toEqual(NOT_READY);
    } finally {
      await db.$disconnect();
    }
  });

  it("reports an empty (unmigrated) or unreachable database as not ready without throwing", async () => {
    dir = mkdtempSync(join(tmpdir(), "wristplan-setup-"));
    const empty = createDb(`file:${join(dir, "empty.db")}`);
    const missing = createDb(`file:${join(dir, "no-such-dir", "x.db")}`);
    try {
      expect(await loadSetupCounts(empty)).toEqual(NOT_READY);
      expect(await loadSetupCounts(missing)).toEqual(NOT_READY);
    } finally {
      await empty.$disconnect();
      await missing.$disconnect();
    }
  });
});
