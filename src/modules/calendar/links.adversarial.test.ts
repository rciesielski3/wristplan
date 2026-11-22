import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createFakePublisher, type FakePublisher } from "../../../test/fake-publisher";
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
import { type MatchActivity, type MatchScheduled, matchWorkouts } from "./match";

const NOW = new Date("2026-06-15T10:00:00Z");
const workoutInput = {
  name: "Easy run",
  sport: "run",
  steps: [{ kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 1 } }],
};

describe("link service under adversarial use", () => {
  let t: TestDb;
  let links: LinkService;
  let publisher: FakePublisher;
  let workoutId: string;

  const seed = (id: string, date: string) =>
    t.db.scheduledWorkout.create({
      data: { id, workoutId, date, status: "pending", externalId: `wristplan-${id}` },
    });
  const activity = (garminActivityId: string, startTime = new Date("2026-06-16T07:00:00Z")) =>
    t.db.activity.create({
      data: { garminActivityId, sport: "running", startTime, lastSyncedAt: NOW },
    });
  const state = async () =>
    (
      await t.db.scheduledWorkout.findMany({
        select: { id: true, linkedGarminActivityId: true, matchSource: true },
        orderBy: { id: "asc" },
      })
    ).map((r) => `${r.id}:${r.linkedGarminActivityId}:${r.matchSource}`);

  beforeEach(async () => {
    t = createTestDb();
    links = createLinkService({ db: t.db });
    publisher = createFakePublisher();
    workoutId = (await createWorkoutRepository(t.db).create(workoutInput)).id;
    await seed("s1", "2026-06-16");
    await seed("s2", "2026-06-17");
    await activity("111");
    await activity("222");
  });
  afterEach(() => t.cleanup());

  describe("concurrency and state transitions", () => {
    it("lets exactly one of two concurrent links to the same activity win, leaving no partial state", async () => {
      for (let round = 0; round < 15; round += 1) {
        await t.db.scheduledWorkout.updateMany({
          data: { linkedGarminActivityId: null, matchSource: null },
        });
        const results = await Promise.allSettled([
          links.linkActivity("s1", "111"),
          links.linkActivity("s2", "111"),
        ]);
        const won = results.filter((r) => r.status === "fulfilled");
        const lost = results.filter((r) => r.status === "rejected");
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(ScheduleConflictError);
        const linked = await t.db.scheduledWorkout.findMany({
          where: { linkedGarminActivityId: "111" },
        });
        expect(linked).toHaveLength(1);
        expect(linked[0]?.matchSource).toBe("manual");
        const loser = (await state()).filter((s) => !s.includes(":111:"));
        expect(loser).toHaveLength(1);
        expect(loser[0]).toMatch(/^s\d:null:null$/);
      }
    });

    it("is idempotent when the same pair is linked repeatedly", async () => {
      const first = await links.linkActivity("s1", "111");
      const again = await links.linkActivity("s1", "111");
      expect(again).toMatchObject({ linkedGarminActivityId: "111", matchSource: "manual" });
      expect(await state()).toEqual(["s1:111:manual", "s2:null:null"]);
      expect(again.createdAt).toEqual(first.createdAt);
    });

    it("frees the old activity when a plan is switched from A to B", async () => {
      await links.linkActivity("s1", "111");
      await links.linkActivity("s1", "222");
      expect(await state()).toEqual(["s1:222:manual", "s2:null:null"]);
      expect(await links.linkActivity("s2", "111")).toMatchObject({
        linkedGarminActivityId: "111",
      });
    });

    it("links after a no-match mark and clears the mark", async () => {
      await links.markNoMatch("s1");
      expect(await links.linkActivity("s1", "111")).toMatchObject({
        linkedGarminActivityId: "111",
        matchSource: "manual",
      });
    });

    it("marks no match on a linked plan and frees its activity", async () => {
      await links.linkActivity("s1", "111");
      await links.markNoMatch("s1");
      expect(await state()).toEqual(["s1:null:none", "s2:null:null"]);
      await links.linkActivity("s2", "111");
    });

    it("unlink on an already automatic plan is a harmless no-op", async () => {
      expect(await links.unlink("s1")).toMatchObject({
        linkedGarminActivityId: null,
        matchSource: null,
      });
      expect(await state()).toEqual(["s1:null:null", "s2:null:null"]);
    });

    it("leaves state untouched when a conflicting link is rejected", async () => {
      await links.linkActivity("s1", "111");
      await links.markNoMatch("s2");
      await expect(links.linkActivity("s2", "111")).rejects.toBeInstanceOf(ScheduleConflictError);
      expect(await state()).toEqual(["s1:111:manual", "s2:null:none"]);
    });

    it("allows a cross-sport and cross-day manual link", async () => {
      await t.db.activity.create({
        data: {
          garminActivityId: "333",
          sport: "cycling",
          startTime: new Date("2030-01-01T00:00:00Z"),
          lastSyncedAt: NOW,
        },
      });
      expect(await links.linkActivity("s1", "333")).toMatchObject({ matchSource: "manual" });
    });
  });

  describe("dangling and unknown stored values", () => {
    it("treats a link whose activity was deleted as automatic in the matcher", async () => {
      await activity("333", new Date("2026-06-16T08:00:00Z"));
      await links.linkActivity("s1", "111");
      await t.db.activity.delete({ where: { garminActivityId: "111" } });

      const plans = await t.db.scheduledWorkout.findMany();
      const acts = await t.db.activity.findMany();
      const scheduled: MatchScheduled[] = plans.map((p) => ({
        id: p.id,
        date: p.date,
        sport: "run",
        createdAt: p.createdAt,
        link: p.linkedGarminActivityId,
        matchSource: p.matchSource as "manual" | null,
      }));
      const activities: MatchActivity[] = acts.map((a) => ({
        id: a.garminActivityId,
        day: a.startTime.toISOString().slice(0, 10),
        typeKey: a.sport,
        startTime: a.startTime,
      }));
      const result = matchWorkouts(scheduled, activities);
      expect(plans.find((p) => p.id === "s1")?.linkedGarminActivityId).toBe("111");
      // s1 falls back to auto and takes the earliest same-day run (222); nothing throws on the stale id.
      expect(result.pairs).toContainEqual({
        scheduledId: "s1",
        activityId: "222",
        source: "auto",
      });
      expect(result.unmatchedActivities).toEqual(["333"]);
    });

    it("lets a dangling link be replaced or cleared", async () => {
      await links.linkActivity("s1", "111");
      await t.db.activity.delete({ where: { garminActivityId: "111" } });
      expect(await links.linkActivity("s1", "222")).toMatchObject({
        linkedGarminActivityId: "222",
      });
      await t.db.activity.delete({ where: { garminActivityId: "222" } });
      expect(await links.unlink("s1")).toMatchObject({ linkedGarminActivityId: null });
    });

    it("reads an unknown stored matchSource as null on link, unlink and no-match results", async () => {
      await t.db.scheduledWorkout.update({ where: { id: "s1" }, data: { matchSource: "weird" } });
      await t.db.scheduledWorkout.update({ where: { id: "s2" }, data: { matchSource: "" } });
      const svc = createScheduleService({ db: t.db, publisher, now: () => NOW });
      const items = await svc.list({ from: "2026-06-16", to: "2026-06-17" });
      expect(items.map((i) => i.matchSource)).toEqual([null, null]);
      expect(await svc.retry("s1")).toMatchObject({ matchSource: null });
    });
  });

  describe("input edge values", () => {
    it.each([
      ["zero", "0"],
      ["leading zeros", "00111"],
      ["negative", "-111"],
      ["plus sign", "+111"],
      ["float", "111.0"],
      ["exponent", "1e2"],
      ["hex", "0x6f"],
      ["17 digits", "12345678901234567"],
      ["padded", " 111"],
      ["trailing space", "111 "],
      ["trailing newline", "111\n"],
      ["tab", "\t111"],
      ["arabic-indic digits", "١٢٣"],
      ["fullwidth digits", "１１１"],
      ["nul byte", "111\u0000"],
      ["proto", "__proto__"],
      ["constructor", "constructor"],
      ["sql", "1' OR '1'='1"],
      ["empty", ""],
      ["huge", "9".repeat(100_000)],
    ])("rejects %s with a validation error and changes nothing", async (_n, id) => {
      await expect(links.linkActivity("s1", id)).rejects.toBeInstanceOf(ScheduleValidationError);
      expect(await state()).toEqual(["s1:null:null", "s2:null:null"]);
    });

    it.each([
      ["array", ["111"]],
      ["object", { equals: "111" }],
      ["null", null],
      ["undefined", undefined],
      ["number", 111],
      ["bigint", 111n],
      ["boolean", true],
    ])("rejects a %s activity id with a validation error", async (_n, id) => {
      await expect(links.linkActivity("s1", id as never)).rejects.toBeInstanceOf(
        ScheduleValidationError,
      );
    });

    it("validates the activity id before looking up the schedule", async () => {
      await expect(links.linkActivity("nope", "0")).rejects.toBeInstanceOf(ScheduleValidationError);
    });

    it.each(["444", "9999999999999999", "9007199254740993"])(
      "answers 404 for a well-formed id %s that matches no activity",
      async (id) => {
        await expect(links.linkActivity("s1", id)).rejects.toBeInstanceOf(ActivityNotFoundError);
      },
    );

    it.each([
      ["empty", ""],
      ["long", "x".repeat(100_000)],
      ["proto", "__proto__"],
      ["sql", "' OR 1=1 --"],
      ["wildcard", "%"],
      ["unicode", "‮\u0000é💥"],
      ["undefined", undefined],
      ["null", null],
      ["number", 1],
      ["filter object", { contains: "" }],
      ["not filter", { not: "" }],
      ["array", ["s1"]],
    ])("answers not-found for schedule id %s and touches nothing", async (_n, id) => {
      for (const run of [
        () => links.linkActivity(id as never, "222"),
        () => links.markNoMatch(id as never),
        () => links.unlink(id as never),
      ]) {
        await expect(run()).rejects.toBeInstanceOf(ScheduleNotFoundError);
      }
      expect(await state()).toEqual(["s1:null:null", "s2:null:null"]);
    });
  });

  describe("interaction with the schedule service", () => {
    const svc = () =>
      createScheduleService({ db: t.db, publisher, now: () => NOW, sleep: async () => {} });
    const scheduled = async () => {
      const w2 = await createWorkoutRepository(t.db).create({ ...workoutInput, name: "Second" });
      return svc().schedule(w2.id, "2026-06-20");
    };

    it("frees the activity when a linked plan is unscheduled", async () => {
      const plan = await scheduled();
      await links.linkActivity(plan.id, "111");
      await svc().unschedule(plan.id);
      expect(await t.db.scheduledWorkout.findUnique({ where: { id: plan.id } })).toBeNull();
      expect(publisher.calls.map((c) => c.method)).toEqual(["publish", "remove"]);
      expect(await links.linkActivity("s1", "111")).toMatchObject({
        linkedGarminActivityId: "111",
      });
    });

    it("keeps the link and match source when a linked plan is rescheduled", async () => {
      const plan = await scheduled();
      await links.linkActivity(plan.id, "111");
      const moved = await svc().reschedule(plan.id, "2026-06-22");
      expect(moved).toMatchObject({
        date: "2026-06-22",
        linkedGarminActivityId: "111",
        matchSource: "manual",
      });
    });

    it("keeps a no-match mark when a plan is rescheduled", async () => {
      const plan = await scheduled();
      await links.markNoMatch(plan.id);
      expect(await svc().reschedule(plan.id, "2026-06-22")).toMatchObject({ matchSource: "none" });
    });

    it("returns null link fields from schedule and retry, and the stored values from retry and list", async () => {
      const plan = await scheduled();
      expect(plan).toMatchObject({ linkedGarminActivityId: null, matchSource: null });
      await links.linkActivity(plan.id, "222");
      expect(await svc().retry(plan.id)).toMatchObject({
        linkedGarminActivityId: "222",
        matchSource: "manual",
      });
      const items = await svc().list({ from: "2026-06-20", to: "2026-06-20" });
      expect(items[0]).toMatchObject({ linkedGarminActivityId: "222", matchSource: "manual" });
    });

    it("keeps the link on a failed plan after a retry that fails again", async () => {
      const plan = await scheduled();
      await links.linkActivity(plan.id, "111");
      await t.db.scheduledWorkout.update({
        where: { id: plan.id },
        data: { status: "failed", remoteEventId: null },
      });
      publisher.failNext("publish", new Error("x"));
      expect(await svc().retry(plan.id)).toMatchObject({
        status: "failed",
        linkedGarminActivityId: "111",
      });
    });

    it("never calls the publisher while linking, marking or unlinking", async () => {
      await links.linkActivity("s1", "111");
      await links.markNoMatch("s1");
      await links.unlink("s1");
      expect(publisher.calls).toEqual([]);
    });
  });
});
