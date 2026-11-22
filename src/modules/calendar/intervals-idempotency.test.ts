import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createFakeIntervalsServer } from "../../../test/fake-intervals-server";
import { createWorkoutRepository } from "../workouts";
import { createIntervalsPublisher } from "./intervals-publisher";
import { createScheduleService } from "./schedule";

const NOW = new Date("2026-06-15T10:00:00Z");
const DATE = "2026-06-20";
const workoutInput = {
  name: "Easy run",
  sport: "run",
  steps: [{ kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 1 } }],
};
const publishInput = {
  externalId: "wristplan-idem-1",
  date: DATE,
  name: "Easy run",
  text: "Warmup\n- 10m Z1 HR",
  sport: "run",
  target: "hr",
} as const;

let t: TestDb;
let server: ReturnType<typeof createFakeIntervalsServer>;
let workoutId: string;

const make = () =>
  createScheduleService({
    db: t.db,
    publisher: createIntervalsPublisher(server.client, { now: () => NOW }),
    now: () => NOW,
    sleep: async () => {},
  });

beforeEach(async () => {
  t = createTestDb();
  server = createFakeIntervalsServer();
  workoutId = (await createWorkoutRepository(t.db).create(workoutInput)).id;
});

afterEach(() => t.cleanup());

describe("intervals publisher idempotency against the live-faithful fake", () => {
  it("publishing the same externalId on different dates yields one event on the latest date", async () => {
    const publisher = createIntervalsPublisher(server.client, { now: () => NOW });
    const first = await publisher.publish(publishInput);
    const second = await publisher.publish({ ...publishInput, date: "2026-06-27" });
    expect(second.remoteId).toBe(first.remoteId);
    expect(server.events.size).toBe(1);
    expect(server.dateOf(Number(first.remoteId))).toBe("2026-06-27");
  });

  it("does not match a foreign event when publishing an owned workout", async () => {
    const foreignId = server.seedForeign(DATE);
    const { remoteId } = await createIntervalsPublisher(server.client, { now: () => NOW }).publish(
      publishInput,
    );
    expect(remoteId).not.toBe(String(foreignId));
    expect(server.events.size).toBe(2);
  });

  it("retry after a lost local update reuses the remote event instead of duplicating", async () => {
    const service = make();
    const spy = vi
      .spyOn(t.db.scheduledWorkout, "update")
      .mockRejectedValueOnce(new Error("disk full"));
    const failed = await service.schedule(workoutId, DATE);
    spy.mockRestore();
    expect(failed).toMatchObject({ status: "failed", remoteEventId: null });
    expect(server.events.size).toBe(1);
    const row = await service.retry(failed.id);
    expect(row.status).toBe("published");
    expect(server.events.size).toBe(1);
    expect(server.events.get(Number(row.remoteEventId))?.external_id).toBe(row.externalId);
  });

  it("recovers a crash before the row was marked published without a duplicate", async () => {
    const service = make();
    const row = await service.schedule(workoutId, DATE);
    await t.db.scheduledWorkout.update({
      where: { id: row.id },
      data: { status: "pending", remoteEventId: null, publishedAt: null },
    });
    const recovered = await service.retry(row.id);
    expect(recovered).toMatchObject({ status: "published", remoteEventId: row.remoteEventId });
    expect(server.events.size).toBe(1);
  });

  it("unschedule of a row with an unknown remote id removes the single remote event", async () => {
    const service = make();
    const row = await service.schedule(workoutId, DATE);
    await t.db.scheduledWorkout.update({
      where: { id: row.id },
      data: { status: "failed", remoteEventId: null },
    });
    await service.unschedule(row.id);
    expect(server.events.size).toBe(0);
    expect(await t.db.scheduledWorkout.count()).toBe(0);
  });

  it("reschedule moves the same remote event and keeps its external id", async () => {
    const service = make();
    const row = await service.schedule(workoutId, DATE);
    await service.reschedule(row.id, "2026-06-25");
    const id = Number(row.remoteEventId);
    expect(server.events.size).toBe(1);
    expect(server.dateOf(id)).toBe("2026-06-25");
    expect(server.events.get(id)?.external_id).toBe(row.externalId);
  });
});
