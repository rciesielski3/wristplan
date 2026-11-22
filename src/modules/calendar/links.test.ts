import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createFakePublisher } from "../../../test/fake-publisher";
import { createWorkoutRepository } from "../workouts";
import {
  ActivityNotFoundError,
  createLinkService,
  createScheduleService,
  type LinkService,
  ScheduleConflictError,
  ScheduleNotFoundError,
  ScheduleValidationError,
} from "./index";

const workoutInput = {
  name: "Easy run",
  sport: "run",
  steps: [{ kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 1 } }],
};

describe("link service", () => {
  let t: TestDb;
  let links: LinkService;
  let s1: string;
  let s2: string;

  const seed = async (id: string, date: string, workoutId: string) => {
    await t.db.scheduledWorkout.create({
      data: { id, workoutId, date, status: "pending", externalId: `wristplan-${id}` },
    });
  };

  beforeEach(async () => {
    t = createTestDb();
    links = createLinkService({ db: t.db });
    const w = await createWorkoutRepository(t.db).create(workoutInput);
    await seed("s1", "2026-06-16", w.id);
    await seed("s2", "2026-06-17", w.id);
    s1 = "s1";
    s2 = "s2";
    for (const garminActivityId of ["111", "222"]) {
      await t.db.activity.create({
        data: { garminActivityId, startTime: new Date(0), lastSyncedAt: new Date(0) },
      });
    }
  });
  afterEach(() => t.cleanup());

  it("links, marks no match and unlinks", async () => {
    expect(await links.linkActivity(s1, "111")).toMatchObject({
      linkedGarminActivityId: "111",
      matchSource: "manual",
    });
    expect(await links.markNoMatch(s1)).toMatchObject({
      linkedGarminActivityId: null,
      matchSource: "none",
    });
    expect(await links.unlink(s1)).toMatchObject({
      linkedGarminActivityId: null,
      matchSource: null,
    });
  });

  it("is idempotent for the same link and allows relinking to another activity", async () => {
    await links.linkActivity(s1, "111");
    expect(await links.linkActivity(s1, "111")).toMatchObject({ linkedGarminActivityId: "111" });
    expect(await links.linkActivity(s1, "222")).toMatchObject({ linkedGarminActivityId: "222" });
    expect(await links.linkActivity(s2, "111")).toMatchObject({ linkedGarminActivityId: "111" });
  });

  it("rejects an activity already linked to another plan", async () => {
    await links.linkActivity(s1, "111");
    await expect(links.linkActivity(s2, "111")).rejects.toBeInstanceOf(ScheduleConflictError);
  });

  it("maps a lost race on the unique index to a conflict", async () => {
    const racing = createLinkService({
      db: {
        scheduledWorkout: {
          findUnique: async (args: { where: { id?: string } }) =>
            args.where.id === undefined ? null : { id: args.where.id },
          update: async () => Promise.reject(Object.assign(new Error("unique"), { code: "P2002" })),
        },
        activity: { findUnique: async () => ({ id: "a" }) },
      } as never,
    });
    await expect(racing.linkActivity(s2, "111")).rejects.toBeInstanceOf(ScheduleConflictError);
  });

  it("rethrows unexpected database errors", async () => {
    const broken = createLinkService({
      db: {
        scheduledWorkout: {
          findUnique: async () => ({ id: s1 }),
          update: async () => Promise.reject(new Error("db down")),
        },
      } as never,
    });
    await expect(broken.unlink(s1)).rejects.toThrow("db down");
  });

  it("404s on unknown schedule or activity", async () => {
    await expect(links.linkActivity("nope", "111")).rejects.toBeInstanceOf(ScheduleNotFoundError);
    await expect(links.markNoMatch("nope")).rejects.toBeInstanceOf(ScheduleNotFoundError);
    await expect(links.unlink("nope")).rejects.toBeInstanceOf(ScheduleNotFoundError);
    await expect(links.linkActivity(s1, "999")).rejects.toBeInstanceOf(ActivityNotFoundError);
    await expect(links.unlink(123 as never)).rejects.toBeInstanceOf(ScheduleNotFoundError);
  });

  it.each(["", "0", "01", "../x", "__proto__", "1e3", "-5", " 1", "1".repeat(17), "９"])(
    "rejects malformed activity id %j",
    async (id) => {
      await expect(links.linkActivity(s1, id)).rejects.toBeInstanceOf(ScheduleValidationError);
    },
  );

  it("rejects a non-string activity id", async () => {
    await expect(links.linkActivity(s1, 111 as never)).rejects.toBeInstanceOf(
      ScheduleValidationError,
    );
  });

  it("reads an unknown stored matchSource as auto", async () => {
    await t.db.scheduledWorkout.update({ where: { id: s1 }, data: { matchSource: "weird" } });
    const service = createScheduleService({
      db: t.db,
      publisher: createFakePublisher(),
      now: () => new Date("2026-06-15T10:00:00Z"),
    });
    const items = await service.list({ from: "2026-06-16", to: "2026-06-16" });
    expect(items[0]?.matchSource).toBeNull();
  });
});
