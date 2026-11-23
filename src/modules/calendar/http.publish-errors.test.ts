import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createFakePublisher, type FakePublisher } from "../../../test/fake-publisher";
import { createWorkoutRepository } from "../workouts";
import {
  createScheduleService,
  handleReschedule,
  handleRetry,
  handleSchedule,
  handleUnschedule,
  PublisherAuthError,
  PublisherForeignEventError,
  PublisherNotFoundError,
  PublisherRateLimitError,
  PublisherRejectedError,
  PublisherTransientError,
  type ScheduleRouteDeps,
} from "./index";

const HOST = "127.0.0.1:3100";
const DATE = "2026-06-20";
const OTHER = "2026-06-22";
const NOW = new Date("2026-06-15T10:00:00Z");
const workoutInput = {
  name: "Easy run",
  sport: "run",
  steps: [{ kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 1 } }],
};

const req = (method: string, body?: unknown) =>
  new Request(`http://${HOST}/x`, {
    method,
    headers: { host: HOST, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const RATE = { error: "intervals.icu rate limit reached; retry later" };
const AUTH = { error: "intervals.icu rejected the credentials" };
const FAILED = { error: "publishing to intervals.icu failed" };
const FOREIGN = { error: "remote event was not created by wristplan" };

interface Case {
  readonly label: string;
  readonly error: () => Error;
  readonly lastError: string;
  // reschedule: remote failure on a published row; unschedule: remote failure on remove.
  readonly reschedule: readonly [number, unknown];
  readonly unschedule: readonly [number, unknown];
}

// Expectations are the pre-change behaviour (reason prefix mapping) written out explicitly.
const cases: readonly Case[] = [
  {
    label: "PublisherRateLimitError",
    error: () => new PublisherRateLimitError(),
    lastError: "PublisherRateLimitError (429)",
    reschedule: [429, RATE],
    unschedule: [429, RATE],
  },
  {
    label: "PublisherAuthError",
    error: () => new PublisherAuthError(401),
    lastError: "PublisherAuthError (401)",
    reschedule: [502, AUTH],
    unschedule: [502, AUTH],
  },
  {
    label: "PublisherAuthError without status",
    error: () => new PublisherAuthError(),
    lastError: "PublisherAuthError",
    reschedule: [502, AUTH],
    unschedule: [502, AUTH],
  },
  {
    label: "PublisherTransientError",
    error: () => new PublisherTransientError(503),
    lastError: "PublisherTransientError (503)",
    reschedule: [502, FAILED],
    unschedule: [502, FAILED],
  },
  {
    label: "PublisherRejectedError",
    error: () => new PublisherRejectedError(422),
    lastError: "PublisherRejectedError (422)",
    reschedule: [502, FAILED],
    unschedule: [502, FAILED],
  },
  {
    label: "PublisherNotFoundError",
    error: () => new PublisherNotFoundError(),
    lastError: "PublisherNotFoundError (404)",
    reschedule: [502, FAILED],
    // already gone remotely counts as removed
    unschedule: [200, { ok: true }],
  },
  {
    label: "PublisherForeignEventError",
    error: () => new PublisherForeignEventError(),
    lastError: "PublisherForeignEventError",
    reschedule: [409, FOREIGN],
    unschedule: [409, FOREIGN],
  },
  {
    label: "plain Error",
    error: () => new Error("secret-detail"),
    lastError: "Error",
    reschedule: [502, FAILED],
    unschedule: [502, FAILED],
  },
  {
    label: "TypeError named like a rate limit only by message",
    error: () => new TypeError("PublisherRateLimitError (429)"),
    lastError: "TypeError",
    reschedule: [502, FAILED],
    unschedule: [502, FAILED],
  },
  {
    label: "non-Error value",
    error: () => "oops" as unknown as Error,
    lastError: "UnknownError",
    reschedule: [502, FAILED],
    unschedule: [502, FAILED],
  },
];

describe("publisher error classes through the real service and handlers", () => {
  let t: TestDb;
  let publisher: FakePublisher;
  let deps: ScheduleRouteDeps;
  let workoutId: string;
  let rowId: string;

  beforeEach(async () => {
    t = createTestDb();
    publisher = createFakePublisher();
    const service = createScheduleService({
      db: t.db,
      publisher,
      now: () => NOW,
      sleep: async () => {},
    });
    deps = { readService: () => service, service: () => service };
    workoutId = (await createWorkoutRepository(t.db).create(workoutInput)).id;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  const publishedRow = async () => {
    const res = await handleSchedule(req("POST", { workoutId, date: DATE }), deps);
    expect(res.status).toBe(201);
    rowId = ((await res.json()) as { id: string }).id;
  };

  describe.each(cases)("$label", (c) => {
    it("keeps status and body of a failed reschedule", async () => {
      await publishedRow();
      publisher.failNext("reschedule", c.error(), 99);
      const res = await handleReschedule(req("PATCH", { date: OTHER }), rowId, deps);
      expect([res.status, await res.json()]).toEqual([...c.reschedule]);
    });

    it("keeps status and body of a failed unschedule", async () => {
      await publishedRow();
      publisher.failNext("remove", c.error(), 99);
      const res = await handleUnschedule(req("DELETE"), rowId, deps);
      expect([res.status, await res.json()]).toEqual([...c.unschedule]);
    });

    it("answers schedule with 201 and a failed row carrying the redacted lastError", async () => {
      publisher.failNext("publish", c.error(), 99);
      const res = await handleSchedule(req("POST", { workoutId, date: DATE }), deps);
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(201);
      expect(body).toMatchObject({ status: "failed", lastError: c.lastError, remoteEventId: null });
    });

    it("answers retry with 200 and a failed row carrying the redacted lastError", async () => {
      publisher.failNext("publish", new PublisherRejectedError(422), 1);
      const first = await handleSchedule(req("POST", { workoutId, date: DATE }), deps);
      const { id } = (await first.json()) as { id: string };
      publisher.failNext("publish", c.error(), 99);
      const res = await handleRetry(req("POST"), id, deps);
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: "failed", lastError: c.lastError });
    });

    it("answers a 502 failed body for unschedule of a never-published row (remote state unknown)", async () => {
      publisher.failNext("publish", c.error(), 99);
      const first = await handleSchedule(req("POST", { workoutId, date: DATE }), deps);
      const { id } = (await first.json()) as { id: string };
      const res = await handleUnschedule(req("DELETE"), id, deps);
      expect([res.status, await res.json()]).toEqual([502, FAILED]);
    });
  });
});
