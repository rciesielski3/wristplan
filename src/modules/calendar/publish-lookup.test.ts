import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createFakeIntervalsServer } from "../../../test/fake-intervals-server";
import { createWorkoutRepository } from "../workouts";
import { MAX_FUTURE_DAYS, MAX_PAST_DAYS, scheduleWindow } from "./dates";
import { createIntervalsPublisher } from "./intervals-publisher";
import {
  PublisherNotFoundError,
  PublisherRateLimitError,
  PublisherTransientError,
  type PublishInput,
} from "./publisher";
import { createScheduleService } from "./schedule";

const NOW = new Date("2026-03-01T10:00:00Z");
const input: PublishInput = {
  externalId: "wristplan-a1",
  date: "2026-03-02",
  name: "Tempo",
  text: "Warmup\n- 10m Z1 HR",
  sport: "run",
  target: "hr",
};

const setup = () => {
  const server = createFakeIntervalsServer();
  return { server, publisher: createIntervalsPublisher(server.client, { now: () => NOW }) };
};
const methods = (server: ReturnType<typeof createFakeIntervalsServer>) =>
  server.fetch.mock.calls.map(([, init]) => init?.method ?? "GET");
const seed = (
  server: ReturnType<typeof createFakeIntervalsServer>,
  id: number,
  external_id: unknown,
  date = "2026-03-02",
) => {
  server.events.set(id, {
    id,
    uid: `u-${id}`,
    external_id,
    start_date_local: `${date}T00:00:00`,
  } as never);
};

describe("scheduleWindow", () => {
  it("spans exactly the legal schedule dates around the injected now", () => {
    expect(scheduleWindow(NOW)).toEqual({ oldest: "2025-02-28", newest: "2028-03-01" });
  });

  it("depends on the UTC day, not the time of day", () => {
    const early = scheduleWindow(new Date("2026-03-01T00:00:00Z"));
    const late = scheduleWindow(new Date("2026-03-01T23:59:59Z"));
    expect(late).toEqual(early);
    expect(scheduleWindow(new Date("2026-03-02T00:00:00Z")).oldest).toBe("2025-03-01");
  });

  it("is exactly MAX_PAST_DAYS back and MAX_FUTURE_DAYS ahead", () => {
    const day = 86_400_000;
    const { oldest, newest } = scheduleWindow(NOW);
    const today = Date.parse("2026-03-01");
    expect((today - Date.parse(oldest)) / day).toBe(MAX_PAST_DAYS);
    expect((Date.parse(newest) - today) / day).toBe(MAX_FUTURE_DAYS);
  });
});

describe("publish lookup edge cases", () => {
  it.each([
    ["different case", "WRISTPLAN-A1"],
    ["leading whitespace", " wristplan-a1"],
    ["trailing whitespace", "wristplan-a1 "],
    ["a non-prefixed id", "other-a1"],
    ["a longer id with the same prefix", "wristplan-a10"],
    ["null", null],
    ["a number", 1],
  ])("does not treat a remote event with external_id %s as a match", async (_n, ext) => {
    const { server, publisher } = setup();
    seed(server, 500, ext);
    const { remoteId } = await publisher.publish(input);
    expect(remoteId).not.toBe("500");
    expect(server.events.size).toBe(2);
    expect(server.events.get(500)?.start_date_local).toBe("2026-03-02T00:00:00");
  });

  it("does not find events one day outside the window (known limitation)", async () => {
    const { server, publisher } = setup();
    const before = "2025-02-27";
    const after = "2028-03-02";
    seed(server, 501, input.externalId, before);
    await publisher.publish(input);
    expect(server.events.size).toBe(2);
    seed(server, 502, "wristplan-b1", after);
    await publisher.publish({ ...input, externalId: "wristplan-b1" });
    expect(server.events.size).toBe(4);
  });

  it.each([
    ["oldest", scheduleWindow(NOW).oldest],
    ["newest", scheduleWindow(NOW).newest],
  ])("finds an event on the %s day of the window and creates no duplicate", async (_n, date) => {
    const { server, publisher } = setup();
    seed(server, 503, input.externalId, date);
    const { remoteId } = await publisher.publish(input);
    expect(remoteId).toBe("503");
    expect(server.events.size).toBe(1);
    expect(methods(server)).not.toContain("POST");
  });

  it("ignores junk list items and still creates", async () => {
    const { server, publisher } = setup();
    server.respondWith((method) =>
      method === "GET"
        ? new Response(JSON.stringify([null, 1, "x", []]), { status: 200 })
        : undefined,
    );
    const { remoteId } = await publisher.publish(input);
    expect(Number(remoteId)).toBeGreaterThan(0);
    expect(server.events.size).toBe(1);
  });
});

describe("publish when the lookup fails", () => {
  it.each([
    [429, PublisherRateLimitError],
    [500, PublisherTransientError],
    [503, PublisherTransientError],
  ])("http %i on the list creates nothing and surfaces a typed error", async (status, expected) => {
    const { server, publisher } = setup();
    server.respondWith((m) => (m === "GET" ? new Response("x", { status }) : undefined));
    await expect(publisher.publish(input)).rejects.toBeInstanceOf(expected);
    expect(methods(server)).toEqual(["GET"]);
    expect(server.events.size).toBe(0);
  });
});

describe("publish when rescheduling the found event fails", () => {
  const seedPublished = async () => {
    const ctx = setup();
    await ctx.publisher.publish(input);
    ctx.server.fetch.mockClear();
    return ctx;
  };

  it("maps a PUT 404 (deleted between list and write) to not found and does not create", async () => {
    const { server, publisher } = await seedPublished();
    server.respondWith((m) => (m === "PUT" ? new Response("x", { status: 404 }) : undefined));
    await expect(publisher.publish({ ...input, date: "2026-03-09" })).rejects.toBeInstanceOf(
      PublisherNotFoundError,
    );
    expect(methods(server)).not.toContain("POST");
    expect(server.events.size).toBe(1);
  });

  it.each([
    [429, PublisherRateLimitError],
    [500, PublisherTransientError],
  ])(
    "maps a PUT %i to a typed error and leaves the event on its old date",
    async (status, expected) => {
      const { server, publisher } = await seedPublished();
      server.respondWith((m) => (m === "PUT" ? new Response("x", { status }) : undefined));
      await expect(publisher.publish({ ...input, date: "2026-03-09" })).rejects.toBeInstanceOf(
        expected,
      );
      expect(methods(server)).not.toContain("POST");
      expect(server.dateOf(100)).toBe("2026-03-02");
    },
  );
});

describe("schedule flows through the live-faithful fake", () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => t.cleanup());

  it("retries a rate limited lookup and publishes exactly one event", async () => {
    const server = createFakeIntervalsServer();
    const sleeps: number[] = [];
    const service = createScheduleService({
      db: t.db,
      publisher: createIntervalsPublisher(server.client, { now: () => NOW }),
      now: () => NOW,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const workout = await createWorkoutRepository(t.db).create({
      name: "Easy",
      sport: "run",
      steps: [
        { kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 1 } },
      ],
    });
    let gets = 0;
    server.respondWith((m) =>
      m === "GET" && gets++ === 0 ? new Response("x", { status: 429 }) : undefined,
    );
    const row = await service.schedule(workout.id, "2026-03-05");
    expect(row.status).toBe("published");
    expect(sleeps).toHaveLength(1);
    expect(server.events.size).toBe(1);
  });
});
