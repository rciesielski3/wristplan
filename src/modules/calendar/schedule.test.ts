import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createFakeIntervalsServer } from "../../../test/fake-intervals-server";
import { createFakePublisher, type FakePublisher } from "../../../test/fake-publisher";
import { createWorkoutRepository, WorkoutNotFoundError } from "../workouts";
import {
  ScheduleConflictError,
  ScheduleForeignEventError,
  ScheduleListOverflowError,
  ScheduleNotFoundError,
  SchedulePublishError,
  ScheduleValidationError,
} from "./errors";
import { createIntervalsPublisher } from "./intervals-publisher";
import {
  PublisherAuthError,
  PublisherError,
  PublisherForeignEventError,
  PublisherRateLimitError,
  PublisherRejectedError,
  PublisherTransientError,
} from "./publisher";
import { createScheduleService, MAX_TRANSIENT_RETRIES, SCHEDULE_LIST_LIMIT } from "./schedule";

const NOW = new Date("2026-06-15T10:00:00Z");
const DATE = "2026-06-20";
const workoutInput = {
  name: "Easy run",
  sport: "run",
  steps: [{ kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 1 } }],
};

let t: TestDb;
let publisher: FakePublisher;
let sleeps: number[];
let service: ReturnType<typeof createScheduleService>;
let workoutId: string;

const make = (p = publisher) =>
  createScheduleService({
    db: t.db,
    publisher: p,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

beforeEach(async () => {
  t = createTestDb();
  publisher = createFakePublisher();
  sleeps = [];
  service = make();
  workoutId = (await createWorkoutRepository(t.db).create(workoutInput)).id;
});

afterEach(() => t.cleanup());

describe("schedule", () => {
  it("publishes and records the remote id", async () => {
    const row = await service.schedule(workoutId, DATE);
    expect(row).toMatchObject({
      workoutId,
      date: DATE,
      status: "published",
      remoteEventId: "1",
      lastError: null,
      publishedAt: NOW,
    });
    expect(row.externalId).toMatch(/^wristplan-.+/);
    expect(publisher.calls[0]?.args[0]).toMatchObject({
      externalId: row.externalId,
      date: DATE,
      name: "Easy run",
      text: "Warmup\n- 10m Z1 HR",
      sport: "run",
      target: "hr",
    });
  });

  it("is idempotent for the same workout and date", async () => {
    const a = await service.schedule(workoutId, DATE);
    const b = await service.schedule(workoutId, DATE);
    expect(b.id).toBe(a.id);
    expect(publisher.remote.size).toBe(1);
    expect(publisher.calls).toHaveLength(1);
    expect(await t.db.scheduledWorkout.count()).toBe(1);
  });

  it("allows the same workout on different dates", async () => {
    await service.schedule(workoutId, DATE);
    await service.schedule(workoutId, "2026-06-21");
    expect(publisher.remote.size).toBe(2);
  });

  it("re-attempts a failed schedule when scheduled again", async () => {
    publisher.failNext("publish", new PublisherRejectedError(400));
    expect((await service.schedule(workoutId, DATE)).status).toBe("failed");
    expect((await service.schedule(workoutId, DATE)).status).toBe("published");
    expect(publisher.remote.size).toBe(1);
  });

  it("surfaces a race loss as the existing row", async () => {
    await service.schedule(workoutId, DATE);
    const spy = vi.spyOn(t.db.scheduledWorkout, "findUnique").mockResolvedValueOnce(null);
    const row = await service.schedule(workoutId, DATE);
    spy.mockRestore();
    expect(row.status).toBe("published");
    expect(await t.db.scheduledWorkout.count()).toBe(1);
  });

  it("rethrows a unique violation whose row cannot be found", async () => {
    await service.schedule(workoutId, DATE);
    const spy = vi.spyOn(t.db.scheduledWorkout, "findUnique").mockResolvedValue(null);
    await expect(service.schedule(workoutId, DATE)).rejects.toMatchObject({ code: "P2002" });
    spy.mockRestore();
  });

  it("rethrows unexpected insert errors", async () => {
    const spy = vi.spyOn(t.db.scheduledWorkout, "create").mockRejectedValue(new Error("disk"));
    await expect(service.schedule(workoutId, DATE)).rejects.toThrow("disk");
    spy.mockRestore();
  });

  it("validates before touching the db or publisher", async () => {
    for (const bad of ["2026-02-30", "2026-6-1", "2020-01-01", "2099-01-01"]) {
      await expect(service.schedule(workoutId, bad)).rejects.toBeInstanceOf(
        ScheduleValidationError,
      );
    }
    await expect(service.schedule("missing", DATE)).rejects.toBeInstanceOf(WorkoutNotFoundError);
    expect(await t.db.scheduledWorkout.count()).toBe(0);
    expect(publisher.calls).toHaveLength(0);
  });

  it("accepts a leap day", async () => {
    const s = createScheduleService({
      db: t.db,
      publisher,
      now: () => new Date("2028-02-01T00:00:00Z"),
    });
    expect((await s.schedule(workoutId, "2028-02-29")).status).toBe("published");
  });

  it("leaves no row when the workout cannot be serialised", async () => {
    const bad = await t.db.workout.create({
      data: {
        definition: JSON.stringify({ ...workoutInput, steps: [] }),
      },
    });
    await expect(service.schedule(bad.id, DATE)).rejects.toThrow();
    expect(await t.db.scheduledWorkout.count()).toBe(0);
    expect(publisher.calls).toHaveLength(0);
  });

  it("does not schedule a corrupt workout", async () => {
    await t.db.workout.update({ where: { id: workoutId }, data: { definition: "{}" } });
    await expect(service.schedule(workoutId, DATE)).rejects.toThrow();
    expect(await t.db.scheduledWorkout.count()).toBe(0);
  });
});

describe("failure handling", () => {
  it.each([
    [new PublisherAuthError(401), "PublisherAuthError (401)"],
    [new PublisherRejectedError(422), "PublisherRejectedError (422)"],
    [new PublisherRejectedError(), "PublisherRejectedError"],
    [new TypeError("token=abc123 leaked"), "TypeError"],
    ["oops" as unknown as Error, "UnknownError"],
  ])("records a failed row with a redacted error (%#)", async (error, expected) => {
    publisher.failNext("publish", error);
    const row = await service.schedule(workoutId, DATE);
    expect(row).toMatchObject({ status: "failed", lastError: expected, remoteEventId: null });
    expect(sleeps).toEqual([]);
    expect(publisher.calls).toHaveLength(1);
  });

  it.each([new PublisherTransientError(503), new PublisherRateLimitError()])(
    "retries %s with capped exponential backoff then succeeds",
    async (error) => {
      publisher.failNext("publish", error, MAX_TRANSIENT_RETRIES);
      expect((await service.schedule(workoutId, DATE)).status).toBe("published");
      expect(sleeps).toEqual([1000, 2000]);
    },
  );

  it("gives up after the retry cap and records failure", async () => {
    publisher.failNext("publish", new PublisherTransientError(500), 99);
    const row = await service.schedule(workoutId, DATE);
    expect(row).toMatchObject({ status: "failed", lastError: "PublisherTransientError (500)" });
    expect(publisher.calls).toHaveLength(MAX_TRANSIENT_RETRIES + 1);
  });

  it("uses the real timer when sleep is not injected", async () => {
    vi.useFakeTimers();
    try {
      const s = createScheduleService({ db: t.db, publisher, now: () => NOW });
      publisher.failNext("publish", new PublisherTransientError(500));
      const pending = s.schedule(workoutId, DATE);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await pending).status).toBe("published");
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults now to the system clock", async () => {
    const s = createScheduleService({ db: t.db, publisher });
    const today = new Date().toISOString().slice(0, 10);
    expect((await s.schedule(workoutId, today)).status).toBe("published");
  });

  it("records a failed row when the stored workout turns corrupt before a retry", async () => {
    publisher.failNext("publish", new PublisherRejectedError(400));
    const failed = await service.schedule(workoutId, DATE);
    await t.db.workout.update({ where: { id: workoutId }, data: { definition: "{}" } });
    const row = await service.retry(failed.id);
    expect(row).toMatchObject({ status: "failed", lastError: "WorkoutCorruptError" });
  });
});

describe("retry and crash recovery", () => {
  it("retries a failed row and publishes it", async () => {
    publisher.failNext("publish", new PublisherRejectedError(400));
    const failed = await service.schedule(workoutId, DATE);
    const row = await service.retry(failed.id);
    expect(row).toMatchObject({ status: "published", lastError: null, remoteEventId: "1" });
  });

  it("recovers a stale pending row left by a crash before publish", async () => {
    const id = "crash-1";
    await t.db.scheduledWorkout.create({
      data: { id, workoutId, date: DATE, status: "pending", externalId: `wristplan-${id}` },
    });
    expect((await service.retry(id)).status).toBe("published");
    expect(publisher.remote.size).toBe(1);
  });

  it("does not duplicate when the crash happened after the remote create", async () => {
    const first = await service.schedule(workoutId, DATE);
    await t.db.scheduledWorkout.update({
      where: { id: first.id },
      data: { status: "pending", remoteEventId: null },
    });
    const row = await service.retry(first.id);
    expect(row.status).toBe("published");
    expect(publisher.remote.size).toBe(1);
    expect(row.remoteEventId).toBe(first.remoteEventId);
  });

  it("publishes a stale pending row when the same date is scheduled again", async () => {
    await t.db.scheduledWorkout.create({
      data: {
        id: "crash-2",
        workoutId,
        date: DATE,
        status: "pending",
        externalId: "wristplan-crash-2",
      },
    });
    const row = await service.schedule(workoutId, DATE);
    expect(row).toMatchObject({ id: "crash-2", status: "published" });
    expect(publisher.remote.size).toBe(1);
  });

  it("returns a published row untouched", async () => {
    const row = await service.schedule(workoutId, DATE);
    expect(await service.retry(row.id)).toEqual(row);
    expect(publisher.calls).toHaveLength(1);
  });

  it("re-checks the date window on retry", async () => {
    publisher.failNext("publish", new PublisherRejectedError(400));
    const failed = await service.schedule(workoutId, DATE);
    const later = createScheduleService({
      db: t.db,
      publisher,
      now: () => new Date("2030-01-01T00:00:00Z"),
    });
    await expect(later.retry(failed.id)).rejects.toBeInstanceOf(ScheduleValidationError);
    expect(publisher.calls).toHaveLength(1);
  });

  it("rejects unknown and non-string ids", async () => {
    await expect(service.retry("nope")).rejects.toBeInstanceOf(ScheduleNotFoundError);
    await expect(service.retry(5 as unknown as string)).rejects.toBeInstanceOf(
      ScheduleNotFoundError,
    );
  });
});

describe("reschedule", () => {
  it("moves a published workout remotely then locally", async () => {
    const row = await service.schedule(workoutId, DATE);
    const moved = await service.reschedule(row.id, "2026-06-25");
    expect(moved).toMatchObject({ date: "2026-06-25", status: "published" });
    expect(publisher.remote.get("1")?.date).toBe("2026-06-25");
  });

  it("is a no-op for the same date", async () => {
    const row = await service.schedule(workoutId, DATE);
    await service.reschedule(row.id, DATE);
    expect(publisher.calls).toHaveLength(1);
  });

  it("retries transient failures", async () => {
    const row = await service.schedule(workoutId, DATE);
    publisher.failNext("reschedule", new PublisherTransientError(502));
    expect((await service.reschedule(row.id, "2026-06-25")).date).toBe("2026-06-25");
    expect(sleeps).toEqual([1000]);
  });

  it("keeps the old date and status on failure and records a redacted error", async () => {
    const row = await service.schedule(workoutId, DATE);
    publisher.failNext("reschedule", new PublisherAuthError(401));
    await expect(service.reschedule(row.id, "2026-06-25")).rejects.toMatchObject({
      name: "SchedulePublishError",
      reason: "PublisherAuthError (401)",
    });
    const stored = await t.db.scheduledWorkout.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({
      date: DATE,
      status: "published",
      lastError: "PublisherAuthError (401)",
    });
    const ok = await service.reschedule(row.id, "2026-06-25");
    expect(ok.lastError).toBeNull();
  });

  it("refuses a foreign remote event and keeps the row", async () => {
    const row = await service.schedule(workoutId, DATE);
    publisher.failNext("reschedule", new PublisherForeignEventError());
    await expect(service.reschedule(row.id, "2026-06-25")).rejects.toBeInstanceOf(
      ScheduleForeignEventError,
    );
    expect((await service.list({ from: DATE, to: DATE }))[0]?.date).toBe(DATE);
  });

  it("only updates the date locally when nothing is published yet", async () => {
    publisher.failNext("publish", new PublisherRejectedError(400));
    const failed = await service.schedule(workoutId, DATE);
    const moved = await service.reschedule(failed.id, "2026-06-25");
    expect(moved).toMatchObject({ status: "failed", date: "2026-06-25" });
    expect(publisher.calls.map((c) => c.method)).toEqual(["publish"]);
    const row = await service.retry(failed.id);
    expect(publisher.remote.get(row.remoteEventId ?? "")?.date).toBe("2026-06-25");
  });

  it("refuses a date the workout already occupies, before any remote call", async () => {
    const a = await service.schedule(workoutId, DATE);
    await service.schedule(workoutId, "2026-06-25");
    await expect(service.reschedule(a.id, "2026-06-25")).rejects.toBeInstanceOf(
      ScheduleConflictError,
    );
    expect(publisher.calls.map((c) => c.method)).toEqual(["publish", "publish"]);
  });

  it("validates the date and the id", async () => {
    const row = await service.schedule(workoutId, DATE);
    await expect(service.reschedule(row.id, "2020-01-01")).rejects.toBeInstanceOf(
      ScheduleValidationError,
    );
    await expect(service.reschedule("nope", "2026-06-25")).rejects.toBeInstanceOf(
      ScheduleNotFoundError,
    );
  });

  it("reports a remote that vanished as a publish failure", async () => {
    const row = await service.schedule(workoutId, DATE);
    publisher.remote.clear();
    await expect(service.reschedule(row.id, "2026-06-25")).rejects.toBeInstanceOf(
      SchedulePublishError,
    );
  });
});

describe("unschedule", () => {
  it("removes remotely then deletes the row", async () => {
    const row = await service.schedule(workoutId, DATE);
    await service.unschedule(row.id);
    expect(publisher.remote.size).toBe(0);
    expect(await t.db.scheduledWorkout.count()).toBe(0);
  });

  it("treats an already-missing remote event as removed", async () => {
    const row = await service.schedule(workoutId, DATE);
    publisher.remote.clear();
    await service.unschedule(row.id);
    expect(await t.db.scheduledWorkout.count()).toBe(0);
  });

  it("removes a pending row that was never published without leaving anything remote", async () => {
    await t.db.scheduledWorkout.create({
      data: { id: "p1", workoutId, date: DATE, status: "pending", externalId: "wristplan-p1" },
    });
    await service.unschedule("p1");
    expect(publisher.remote.size).toBe(0);
    expect(await t.db.scheduledWorkout.count()).toBe(0);
    expect(publisher.calls.map((c) => c.method)).toEqual(["publish", "remove"]);
  });

  it("resolves and removes a remote event behind a failed row without remoteEventId", async () => {
    const row = await service.schedule(workoutId, DATE);
    await t.db.scheduledWorkout.update({
      where: { id: row.id },
      data: { status: "failed", remoteEventId: null, lastError: "PublisherTransientError" },
    });
    expect(publisher.remote.size).toBe(1);
    await service.unschedule(row.id);
    expect(publisher.remote.size).toBe(0);
    expect(await t.db.scheduledWorkout.count()).toBe(0);
  });

  it("keeps the row and throws when the remote state cannot be resolved", async () => {
    publisher.failNext("publish", new PublisherRejectedError(400), 99);
    const row = await service.schedule(workoutId, DATE);
    await expect(service.unschedule(row.id)).rejects.toMatchObject({
      name: "SchedulePublishError",
      reason: "remote state unknown",
    });
    const stored = await t.db.scheduledWorkout.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({ status: "failed", lastError: "PublisherRejectedError (400)" });
    expect(publisher.calls.map((c) => c.method)).not.toContain("remove");
  });

  it("surfaces a foreign event as a typed refusal and keeps the row", async () => {
    const row = await service.schedule(workoutId, DATE);
    publisher.failNext("remove", new PublisherForeignEventError());
    await expect(service.unschedule(row.id)).rejects.toBeInstanceOf(ScheduleForeignEventError);
    const stored = await t.db.scheduledWorkout.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.status).toBe("published");
    expect(stored.lastError).toBe("PublisherForeignEventError");
  });

  it("keeps the row on other failures", async () => {
    const row = await service.schedule(workoutId, DATE);
    publisher.failNext("remove", new PublisherTransientError(500), 99);
    await expect(service.unschedule(row.id)).rejects.toBeInstanceOf(SchedulePublishError);
    expect(await t.db.scheduledWorkout.count()).toBe(1);
    expect(publisher.calls.filter((c) => c.method === "remove")).toHaveLength(
      MAX_TRANSIENT_RETRIES + 1,
    );
  });

  it("rejects unknown ids", async () => {
    await expect(service.unschedule("nope")).rejects.toBeInstanceOf(ScheduleNotFoundError);
  });
});

describe("list", () => {
  it("returns rows in the inclusive range ordered by date", async () => {
    for (const d of ["2026-06-22", "2026-06-20", "2026-06-21", "2026-07-30"]) {
      await service.schedule(workoutId, d);
    }
    const rows = await service.list({ from: "2026-06-20", to: "2026-06-22" });
    expect(rows.map((r) => r.date)).toEqual(["2026-06-20", "2026-06-21", "2026-06-22"]);
  });

  it("shows pending, published and failed statuses", async () => {
    await service.schedule(workoutId, "2026-06-20");
    publisher.failNext("publish", new PublisherRejectedError(400));
    await service.schedule(workoutId, "2026-06-21");
    await t.db.scheduledWorkout.create({
      data: { workoutId, date: "2026-06-22", status: "pending", externalId: "wristplan-p" },
    });
    const rows = await service.list({ from: "2026-06-20", to: "2026-06-22" });
    expect(rows.map((r) => r.status)).toEqual(["published", "failed", "pending"]);
  });

  it("validates the range and bounds the result size", async () => {
    await expect(service.list({ from: "2026-06-22", to: "2026-06-20" })).rejects.toBeInstanceOf(
      ScheduleValidationError,
    );
  });
});

describe("foreign key", () => {
  it("blocks deleting a workout that has a schedule, then allows it after unschedule", async () => {
    const row = await service.schedule(workoutId, DATE);
    const repo = createWorkoutRepository(t.db);
    await expect(repo.delete(workoutId)).rejects.toThrow();
    expect(await t.db.workout.count({ where: { id: workoutId } })).toBe(1);
    expect(publisher.remote.size).toBe(1);
    await service.unschedule(row.id);
    await repo.delete(workoutId);
    expect(await t.db.workout.count()).toBe(0);
  });

  it("rejects a schedule row for an unknown workout", async () => {
    await expect(
      t.db.scheduledWorkout.create({
        data: { workoutId: "ghost", date: DATE, status: "pending", externalId: "wristplan-g" },
      }),
    ).rejects.toThrow();
  });
});

describe("with the intervals adapter", () => {
  it("runs the full lifecycle through the client", async () => {
    const server = createFakeIntervalsServer();
    const s = make(
      createIntervalsPublisher(server.client, { now: () => NOW }) as unknown as FakePublisher,
    );
    const row = await s.schedule(workoutId, DATE);
    expect(server.events.get(Number(row.remoteEventId))?.external_id).toBe(row.externalId);
    await s.reschedule(row.id, "2026-06-25");
    expect(server.events.get(Number(row.remoteEventId))?.start_date_local).toBe(
      "2026-06-25T00:00:00",
    );
    await s.unschedule(row.id);
    expect(server.events.size).toBe(0);
  });

  it("refuses to touch a foreign intervals event even if a row points at it", async () => {
    const server = createFakeIntervalsServer();
    const s = make(
      createIntervalsPublisher(server.client, { now: () => NOW }) as unknown as FakePublisher,
    );
    const foreign = server.seedForeign(DATE);
    const row = await t.db.scheduledWorkout.create({
      data: {
        workoutId,
        date: DATE,
        status: "published",
        externalId: "wristplan-f",
        remoteEventId: String(foreign),
      },
    });
    await expect(s.unschedule(row.id)).rejects.toBeInstanceOf(ScheduleForeignEventError);
    await expect(s.reschedule(row.id, "2026-06-25")).rejects.toBeInstanceOf(
      ScheduleForeignEventError,
    );
    expect(server.events.has(foreign)).toBe(true);
    expect(server.events.get(foreign)?.start_date_local).toBe(`${DATE}T00:00:00`);
  });
});

describe("ownership and error hygiene", () => {
  it("always issues unique wristplan- external ids unrelated to workout id or date", async () => {
    const rows = [];
    for (const d of ["2026-06-20", "2026-06-21", "2026-06-22"]) {
      rows.push(await service.schedule(workoutId, d));
    }
    const ids = rows.map((r) => r.externalId);
    expect(new Set(ids).size).toBe(3);
    for (const [i, id] of ids.entries()) {
      expect(id).toMatch(/^wristplan-[0-9a-f-]{36}$/);
      expect(id).not.toContain(workoutId);
      expect(id).not.toContain(rows[i]?.date ?? "?");
    }
  });

  it("never stores a publisher message, only class and status", async () => {
    publisher.failNext("publish", new PublisherError("token=abc123 body={x}", 500));
    const row = await service.schedule(workoutId, DATE);
    expect(row.lastError).toBe("PublisherError (500)");
  });

  it("does not leak an unknown error message through a thrown unschedule error", async () => {
    const row = await service.schedule(workoutId, DATE);
    publisher.failNext("remove", new TypeError("SELECT secret FROM x; token=abc123"));
    const error = await service.unschedule(row.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SchedulePublishError);
    expect(String(error)).not.toMatch(/SELECT|abc123/);
    const stored = await t.db.scheduledWorkout.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.lastError).toBe("TypeError");
  });

  it.each([
    new PublisherAuthError(403),
    new PublisherForeignEventError(),
    new PublisherRejectedError(422),
  ])("does not retry %s when moving or removing", async (error) => {
    const row = await service.schedule(workoutId, DATE);
    publisher.failNext("reschedule", error);
    await expect(service.reschedule(row.id, "2026-06-25")).rejects.toThrow();
    publisher.failNext("remove", error);
    await expect(service.unschedule(row.id)).rejects.toThrow();
    expect(sleeps).toEqual([]);
    expect(publisher.calls.map((c) => c.method)).toEqual(["publish", "reschedule", "remove"]);
  });

  it("retries a rate limit on remove with 1s then 2s backoff, then gives up", async () => {
    const row = await service.schedule(workoutId, DATE);
    publisher.failNext("remove", new PublisherRateLimitError(), 99);
    await expect(service.unschedule(row.id)).rejects.toBeInstanceOf(SchedulePublishError);
    expect(sleeps).toEqual([1000, 2000]);
    expect(publisher.remote.size).toBe(1);
  });

  it("never reschedules or deletes a foreign event through the adapter, whatever the row says", async () => {
    const server = createFakeIntervalsServer();
    const s = make(
      createIntervalsPublisher(server.client, { now: () => NOW }) as unknown as FakePublisher,
    );
    const foreign = server.seedForeign(DATE);
    const row = await t.db.scheduledWorkout.create({
      data: {
        workoutId,
        date: DATE,
        status: "published",
        externalId: "wristplan-f2",
        remoteEventId: String(foreign),
      },
    });
    await expect(s.unschedule(row.id)).rejects.toBeInstanceOf(ScheduleForeignEventError);
    const writes = server.fetch.mock.calls.filter(([, init]) => init?.method !== "GET");
    expect(writes).toEqual([]);
    expect(await t.db.scheduledWorkout.count()).toBe(1);
  });
});

describe("crash points and concurrency", () => {
  it("records failure when the row update fails after the remote create, then retries without a duplicate", async () => {
    const spy = vi
      .spyOn(t.db.scheduledWorkout, "update")
      .mockRejectedValueOnce(new Error("disk full"));
    const failed = await service.schedule(workoutId, DATE);
    spy.mockRestore();
    expect(failed).toMatchObject({ status: "failed", lastError: "Error", remoteEventId: null });
    expect(publisher.remote.size).toBe(1);
    const row = await service.retry(failed.id);
    expect(row.status).toBe("published");
    expect(publisher.remote.size).toBe(1);
  });

  it("converges when the remote move succeeded but the local update failed", async () => {
    const row = await service.schedule(workoutId, DATE);
    const spy = vi
      .spyOn(t.db.scheduledWorkout, "update")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(service.reschedule(row.id, "2026-06-25")).rejects.toThrow("disk full");
    spy.mockRestore();
    expect(publisher.remote.get("1")?.date).toBe("2026-06-25");
    expect((await service.list({ from: DATE, to: DATE }))[0]?.id).toBe(row.id);
    const moved = await service.reschedule(row.id, "2026-06-25");
    expect(moved.date).toBe("2026-06-25");
    expect(publisher.remote.size).toBe(1);
  });

  it("converges when the remote delete succeeded but the local delete failed", async () => {
    const row = await service.schedule(workoutId, DATE);
    const spy = vi
      .spyOn(t.db.scheduledWorkout, "deleteMany")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(service.unschedule(row.id)).rejects.toThrow("disk full");
    spy.mockRestore();
    expect(publisher.remote.size).toBe(0);
    await service.unschedule(row.id);
    expect(await t.db.scheduledWorkout.count()).toBe(0);
  });

  it("creates one row and one remote event for concurrent schedules of the same date", async () => {
    const results = await Promise.all([
      service.schedule(workoutId, DATE),
      service.schedule(workoutId, DATE),
      service.schedule(workoutId, DATE),
    ]);
    expect(await t.db.scheduledWorkout.count()).toBe(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(publisher.remote.size).toBe(1);
  });

  it("does not duplicate remotely when a failed row is retried concurrently", async () => {
    publisher.failNext("publish", new PublisherRejectedError(400));
    const failed = await service.schedule(workoutId, DATE);
    await Promise.all([service.retry(failed.id), service.retry(failed.id)]);
    expect(publisher.remote.size).toBe(1);
    expect((await service.retry(failed.id)).status).toBe("published");
  });

  it("keeps a failed row's error visible and moves it when rescheduled", async () => {
    publisher.failNext("publish", new PublisherRejectedError(422));
    const failed = await service.schedule(workoutId, DATE);
    const moved = await service.reschedule(failed.id, "2026-06-25");
    expect(moved).toMatchObject({ status: "failed", lastError: "PublisherRejectedError (422)" });
  });

  it("schedules different workouts on the same date independently", async () => {
    const other = (await createWorkoutRepository(t.db).create(workoutInput)).id;
    await service.schedule(workoutId, DATE);
    await service.schedule(other, DATE);
    expect(publisher.remote.size).toBe(2);
  });

  it("rejects an unknown workout before creating a row", async () => {
    await expect(service.schedule("ghost", DATE)).rejects.toBeInstanceOf(WorkoutNotFoundError);
    expect(await t.db.scheduledWorkout.count()).toBe(0);
  });
});

describe("list bounds", () => {
  const seed = (n: number, date: (i: number) => string) =>
    t.db.scheduledWorkout.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        id: `row-${String(i).padStart(4, "0")}`,
        workoutId,
        date: date(i),
        status: "pending",
        externalId: `wristplan-seed-${i}`,
      })),
    });

  const seedRows = async (count: number) => {
    const ids = await Promise.all(
      Array.from({ length: count }, () => createWorkoutRepository(t.db).create(workoutInput)),
    );
    await t.db.scheduledWorkout.createMany({
      data: ids.map((w, i) => ({
        id: `row-${String(i).padStart(4, "0")}`,
        workoutId: w.id,
        date: DATE,
        status: "pending",
        externalId: `wristplan-seed-${i}`,
      })),
    });
  };

  it("returns every row when the range holds exactly the cap", async () => {
    await seedRows(SCHEDULE_LIST_LIMIT);
    const rows = await service.list({ from: DATE, to: DATE });
    expect(rows).toHaveLength(SCHEDULE_LIST_LIMIT);
    expect(rows[0]?.id).toBe("row-0000");
  });

  it("throws instead of truncating when more rows than the cap match", async () => {
    await seedRows(SCHEDULE_LIST_LIMIT + 1);
    await expect(service.list({ from: DATE, to: DATE })).rejects.toBeInstanceOf(
      ScheduleListOverflowError,
    );
  });

  it("orders by date then id and includes both inclusive bounds", async () => {
    await seed(1, () => "2026-06-21");
    await t.db.scheduledWorkout.createMany({
      data: [
        { id: "b", workoutId, date: "2026-06-20", status: "pending", externalId: "wristplan-b" },
        {
          id: "a",
          workoutId: await otherWorkout(),
          date: "2026-06-20",
          status: "pending",
          externalId: "wristplan-a",
        },
        { id: "c", workoutId, date: "2026-06-22", status: "pending", externalId: "wristplan-c" },
        { id: "d", workoutId, date: "2026-06-23", status: "pending", externalId: "wristplan-d" },
        { id: "e", workoutId, date: "2026-06-19", status: "pending", externalId: "wristplan-e" },
      ],
    });
    const rows = await service.list({ from: "2026-06-20", to: "2026-06-22" });
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "row-0000", "c"]);
  });

  it("accepts a 366-day span and rejects 367 days", async () => {
    await expect(service.list({ from: "2026-01-01", to: "2027-01-02" })).resolves.toEqual([]);
    await expect(service.list({ from: "2026-01-01", to: "2027-01-03" })).rejects.toBeInstanceOf(
      ScheduleValidationError,
    );
  });
});

async function otherWorkout(): Promise<string> {
  return (await createWorkoutRepository(t.db).create(workoutInput)).id;
}
