import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createFakePublisher, type FakePublisher } from "../../../test/fake-publisher";
import { createWorkoutRepository } from "../workouts";
import {
  createScheduleService,
  handleReschedule,
  handleRetry,
  handleSchedule,
  handleScheduleList,
  handleUnschedule,
  PublisherAuthError,
  PublisherRateLimitError,
  PublisherTransientError,
  ScheduleNotConfiguredError,
  type ScheduleRouteDeps,
  type ScheduleService,
} from "./index";

const HOST = "127.0.0.1:3100";
const DATE = "2026-06-20";
const NOW = new Date("2026-06-15T10:00:00Z");
const workoutInput = {
  name: "Easy run",
  sport: "run",
  steps: [{ kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 1 } }],
};

const req = (method: string, path = "/api/schedule", init: RequestInit = {}) =>
  new Request(`http://${HOST}${path}`, {
    method,
    ...init,
    headers: { host: HOST, ...(init.headers as Record<string, string> | undefined) },
  });
const send = (method: string, body: unknown, extra: Record<string, string> = {}) =>
  req(method, "/x", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...extra },
  });
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("schedule handlers", () => {
  let t: TestDb;
  let publisher: FakePublisher;
  let service: ScheduleService;
  let deps: ScheduleRouteDeps;
  let workoutId: string;
  beforeEach(async () => {
    t = createTestDb();
    publisher = createFakePublisher();
    service = createScheduleService({
      db: t.db,
      publisher,
      now: () => NOW,
      sleep: async () => {},
    });
    deps = { readService: () => service, service: () => service };
    workoutId = (await createWorkoutRepository(t.db).create(workoutInput)).id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.cleanup();
  });

  it("schedules, lists, reschedules, retries and unschedules", async () => {
    const created = await handleSchedule(send("POST", { workoutId, date: DATE }), deps);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const body = await bodyOf(created);
    expect(Object.keys(body).sort()).toEqual([
      "createdAt",
      "date",
      "id",
      "lastError",
      "linkedGarminActivityId",
      "matchSource",
      "publishedAt",
      "remoteEventId",
      "status",
      "updatedAt",
      "workoutId",
    ]);
    expect(body).toMatchObject({
      workoutId,
      date: DATE,
      status: "published",
      remoteEventId: "1",
      lastError: null,
      publishedAt: NOW.toISOString(),
    });
    const id = body.id as string;

    const listed = await handleScheduleList(
      req("GET", "/api/schedule?from=2026-06-01&to=2026-06-30"),
      deps,
    );
    expect(((await bodyOf(listed)).items as unknown[]).length).toBe(1);

    const moved = await handleReschedule(send("PATCH", { date: "2026-06-21" }), id, deps);
    expect(await bodyOf(moved)).toMatchObject({ date: "2026-06-21", status: "published" });

    const retried = await handleRetry(req("POST"), id, deps);
    expect(retried.status).toBe(200);

    expect(await bodyOf(await handleUnschedule(req("DELETE"), id, deps))).toEqual({ ok: true });
    expect(publisher.remote.size).toBe(0);
    expect((await handleUnschedule(req("DELETE"), id, deps)).status).toBe(404);
  });

  it("retries a failed schedule and exposes only the stored error class", async () => {
    publisher.failNext("publish", new PublisherAuthError(401));
    const failed = await bodyOf(
      await handleSchedule(send("POST", { workoutId, date: DATE }), deps),
    );
    expect(failed).toMatchObject({ status: "failed", lastError: "PublisherAuthError (401)" });
    const retried = await bodyOf(await handleRetry(req("POST"), failed.id as string, deps));
    expect(retried).toMatchObject({ status: "published", lastError: null });
  });

  it("validates list ranges", async () => {
    const list = (q: string) => handleScheduleList(req("GET", `/api/schedule${q}`), deps);
    for (const q of [
      "",
      "?from=2026-06-01",
      "?from=2026-6-1&to=2026-06-30",
      "?from=2026-02-30&to=2026-03-01",
      "?from=2026-06-30&to=2026-06-01",
      "?from=2020-01-01&to=2026-06-01",
    ]) {
      expect((await list(q)).status).toBe(422);
    }
  });

  it("maps a list overflow to 422", async () => {
    const overflow = createScheduleService({ db: t.db, publisher });
    vi.spyOn(t.db.scheduledWorkout, "findMany").mockResolvedValue(
      Array.from({ length: 501 }, () => ({}) as never),
    );
    const res = await handleScheduleList(req("GET", "/x?from=2026-06-01&to=2026-06-02"), {
      ...deps,
      readService: () => overflow,
    });
    expect(res.status).toBe(422);
    expect((await bodyOf(res)).error).toMatch(/narrow the date range/);
  });

  it("validates schedule bodies", async () => {
    const post = (body: unknown) => handleSchedule(send("POST", body), deps);
    expect((await post({ workoutId, date: "tomorrow" })).status).toBe(422);
    expect((await post({ workoutId, date: "2030-01-01" })).status).toBe(422);
    expect((await post({ workoutId })).status).toBe(422);
    expect((await post({ workoutId: 5, date: DATE })).status).toBe(422);
    expect((await post([])).status).toBe(422);
    expect((await post(null)).status).toBe(422);
    expect((await post({ workoutId: "nope", date: DATE })).status).toBe(404);
    expect((await handleReschedule(send("PATCH", {}), "abc", deps)).status).toBe(422);
    expect((await handleReschedule(send("PATCH", { date: DATE }), "../x", deps)).status).toBe(404);
  });

  it("rejects bad content type, bad JSON and oversized bodies", async () => {
    const wrong = req("POST", "/x", { body: "{}", headers: { "content-type": "text/plain" } });
    expect((await handleSchedule(wrong, deps)).status).toBe(415);
    expect((await handleSchedule(req("POST"), deps)).status).toBe(415);
    expect((await handleSchedule(send("POST", "{nope"), deps)).status).toBe(400);
    expect((await handleReschedule(send("PATCH", ""), "a", deps)).status).toBe(400);
    const big = JSON.stringify({ pad: "x".repeat(64 * 1024) });
    expect((await handleSchedule(send("POST", big), deps)).status).toBe(413);
  });

  it("enforces Host on reads and Host + CSRF on mutations", async () => {
    const evil = new Request("http://evil.example/api/schedule", {
      headers: { host: "evil.example" },
    });
    expect((await handleScheduleList(evil, deps)).status).toBe(403);
    const cross = { origin: "http://evil.example" };
    const site = { "sec-fetch-site": "cross-site" };
    for (const extra of [cross, site]) {
      expect(
        (await handleSchedule(send("POST", { workoutId, date: DATE }, extra), deps)).status,
      ).toBe(403);
      expect((await handleReschedule(send("PATCH", { date: DATE }, extra), "a", deps)).status).toBe(
        403,
      );
      expect((await handleRetry(req("POST", "/x", { headers: extra }), "a", deps)).status).toBe(
        403,
      );
      expect(
        (await handleUnschedule(req("DELETE", "/x", { headers: extra }), "a", deps)).status,
      ).toBe(403);
    }
    expect(publisher.calls).toEqual([]);
  });

  it("maps publish failures without echoing detail", async () => {
    const created = await bodyOf(
      await handleSchedule(send("POST", { workoutId, date: DATE }), deps),
    );
    const id = created.id as string;
    const cases: [Error, number, RegExp][] = [
      [new PublisherRateLimitError(), 429, /rate limit/],
      [new PublisherAuthError(401), 502, /credentials/],
      [new PublisherTransientError(503), 502, /failed/],
    ];
    for (const [error, status, message] of cases) {
      publisher.failNext("reschedule", error, 5);
      const res = await handleReschedule(send("PATCH", { date: "2026-06-22" }), id, deps);
      expect(res.status).toBe(status);
      const text = JSON.stringify(await bodyOf(res));
      expect(text).toMatch(message);
      expect(text).not.toMatch(/Publisher|503|401/);
    }
  });

  it("maps conflict, foreign event and unknown remote state", async () => {
    const a = await bodyOf(await handleSchedule(send("POST", { workoutId, date: DATE }), deps));
    const b = await bodyOf(
      await handleSchedule(send("POST", { workoutId, date: "2026-06-22" }), deps),
    );
    const conflict = await handleReschedule(send("PATCH", { date: DATE }), b.id as string, deps);
    expect(conflict.status).toBe(409);

    const remoteId = a.remoteEventId as string;
    const event = publisher.remote.get(remoteId);
    if (event) event.foreign = true;
    const foreign = await handleUnschedule(req("DELETE"), a.id as string, deps);
    expect(foreign.status).toBe(409);
    expect(await bodyOf(foreign)).toEqual({ error: "remote event was not created by wristplan" });
  });

  it("maps a corrupt stored workout to 409", async () => {
    await t.db.workout.update({ where: { id: workoutId }, data: { definition: "{bad" } });
    const res = await handleSchedule(send("POST", { workoutId, date: DATE }), deps);
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: "stored workout is corrupt" });
  });

  it("returns 503 for publish routes without a key but still lists", async () => {
    const noKey: ScheduleRouteDeps = {
      readService: () => service,
      service: () => {
        throw new ScheduleNotConfiguredError();
      },
    };
    const expected = { error: "intervals.icu is not configured" };
    for (const res of [
      await handleSchedule(send("POST", { workoutId, date: DATE }), noKey),
      await handleRetry(req("POST"), "a", noKey),
      await handleReschedule(send("PATCH", { date: DATE }), "a", noKey),
      await handleUnschedule(req("DELETE"), "a", noKey),
    ]) {
      expect(res.status).toBe(503);
      expect(await bodyOf(res)).toEqual(expected);
    }
    const list = await handleScheduleList(req("GET", "/x?from=2026-06-01&to=2026-06-30"), noKey);
    expect(list.status).toBe(200);
  });

  it("returns a generic 500 that never echoes the error message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom: ScheduleRouteDeps = {
      ...deps,
      readService: () => {
        throw new Error("SECRET-DETAIL");
      },
      service: () => {
        throw "SECRET-DETAIL";
      },
    };
    const a = await handleScheduleList(req("GET", "/x?from=2026-06-01&to=2026-06-02"), boom);
    const b = await handleRetry(req("POST"), "a", boom);
    for (const res of [a, b]) {
      expect(res.status).toBe(500);
      expect(await bodyOf(res)).toEqual({ error: "internal error" });
    }
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-DETAIL");
  });
});
