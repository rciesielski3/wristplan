import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createFakePublisher, type FakePublisher } from "../../../test/fake-publisher";
import { MAX_BODY_BYTES } from "../../lib/http";
import { createWorkoutRepository } from "../workouts";
import {
  createScheduleService,
  handleReschedule,
  handleRetry,
  handleSchedule,
  handleScheduleList,
  handleUnschedule,
  MAX_LIST_RANGE_DAYS,
  PublisherAuthError,
  ScheduleForeignEventError,
  ScheduleNotConfiguredError,
  SchedulePublishError,
  type ScheduleRouteDeps,
  type ScheduleService,
} from "./index";

const HOST = "localhost:3100";
const DATE = "2026-06-20";
const NOW = new Date("2026-06-15T10:00:00Z");
const SECRET = "FAKE-SECRET-1111";
const workoutInput = {
  name: "Easy run",
  sport: "run",
  steps: [{ kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 1 } }],
};
const jsonHeaders = { host: HOST, "content-type": "application/json" };
const call = (
  method: string,
  body?: BodyInit | null,
  headers: Record<string, string> = jsonHeaders,
) =>
  new Request(`http://${HOST}/api/schedule`, {
    method,
    ...(body === undefined ? {} : { body }),
    headers,
  });
const get = (query: string, headers: Record<string, string> = { host: HOST }) =>
  new Request(`http://${HOST}/api/schedule${query}`, { headers });
const textOf = (res: Response) => res.text();

describe("schedule handlers under hostile input", () => {
  let t: TestDb;
  let publisher: FakePublisher;
  let service: ScheduleService;
  let deps: ScheduleRouteDeps;
  let workoutId: string;
  beforeEach(async () => {
    t = createTestDb();
    publisher = createFakePublisher();
    service = createScheduleService({ db: t.db, publisher, now: () => NOW, sleep: async () => {} });
    deps = { readService: () => service, service: () => service };
    workoutId = (await createWorkoutRepository(t.db).create(workoutInput)).id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.cleanup();
  });
  const rows = () => t.db.scheduledWorkout.count();
  const stub = (over: Partial<ScheduleService>): ScheduleRouteDeps => {
    const s = { ...service, ...over } as ScheduleService;
    return { readService: () => s, service: () => s };
  };

  describe("body shape", () => {
    it.each([
      ["null", "null"],
      ["array", "[]"],
      ["number", "5"],
      ["string", '"x"'],
      ["boolean", "true"],
      ["empty object", "{}"],
    ])("rejects a %s body on schedule with 422 and no row", async (_n, raw) => {
      expect((await handleSchedule(call("POST", raw), deps)).status).toBe(422);
      expect(await rows()).toBe(0);
    });

    it.each([
      [{ workoutId: 1, date: DATE }],
      [{ workoutId: null, date: DATE }],
      [{ workoutId: ["a"], date: DATE }],
      [{ workoutId: { $ne: "" }, date: DATE }],
      [{ workoutId, date: 20260620 }],
      [{ workoutId, date: null }],
      [{ workoutId, date: [DATE] }],
    ])("rejects wrongly typed fields %j with 422", async (body) => {
      expect((await handleSchedule(call("POST", JSON.stringify(body)), deps)).status).toBe(422);
      expect(await rows()).toBe(0);
    });

    it("ignores unknown and prototype-polluting extra fields", async () => {
      const raw = `{"workoutId":"${workoutId}","date":"${DATE}","__proto__":{"x":1},"status":"failed","id":"evil"}`;
      const res = await handleSchedule(call("POST", raw), deps);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; status: string };
      expect(body.id).not.toBe("evil");
      expect(body.status).toBe("published");
      expect(({} as Record<string, unknown>).x).toBeUndefined();
    });

    it("rejects non-object bodies on reschedule", async () => {
      for (const raw of ["null", "[]", "7", "{}", '{"date":5}']) {
        expect((await handleReschedule(call("PATCH", raw), "a", deps)).status).toBe(422);
      }
    });
  });

  describe("body size and content type", () => {
    it("rejects a declared length over the cap with 413 before reading", async () => {
      const res = await handleSchedule(
        call("POST", "{}", { ...jsonHeaders, "content-length": String(MAX_BODY_BYTES + 1) }),
        deps,
      );
      expect(res.status).toBe(413);
    });

    it("rejects an undeclared oversized body with 413 and creates nothing", async () => {
      const big = JSON.stringify({ workoutId, date: DATE, pad: "x".repeat(MAX_BODY_BYTES) });
      expect((await handleSchedule(call("POST", big), deps)).status).toBe(413);
      expect(await rows()).toBe(0);
    });

    it("rejects an oversized body on reschedule with 413", async () => {
      const big = JSON.stringify({ date: DATE, pad: "x".repeat(MAX_BODY_BYTES) });
      expect((await handleReschedule(call("PATCH", big), "a", deps)).status).toBe(413);
    });

    it("treats a non-numeric content-length as undeclared and still reads the body", async () => {
      const body = JSON.stringify({ workoutId, date: DATE });
      const res = await handleSchedule(
        call("POST", body, { ...jsonHeaders, "content-length": "abc" }),
        deps,
      );
      expect(res.status).toBe(201);
    });

    it.each([
      "application/json; charset=utf-8",
      "Application/JSON",
      "  application/json ;charset=UTF-8",
    ])("accepts content-type %j", async (type) => {
      const body = JSON.stringify({ workoutId, date: DATE });
      const res = await handleSchedule(
        call("POST", body, { host: HOST, "content-type": type }),
        deps,
      );
      expect(res.status).toBe(201);
    });

    it.each([
      "text/plain",
      "application/jsonp",
      "application/json5",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/vnd.api+json",
      "",
    ])("rejects content-type %j with 415 and creates nothing", async (type) => {
      const body = JSON.stringify({ workoutId, date: DATE });
      const res = await handleSchedule(
        call("POST", body, { host: HOST, "content-type": type }),
        deps,
      );
      expect(res.status).toBe(415);
      expect(await rows()).toBe(0);
    });

    it("rejects a missing content-type on every body-reading route with 415", async () => {
      const noType = { host: HOST };
      expect((await handleSchedule(call("POST", "{}", noType), deps)).status).toBe(415);
      expect((await handleReschedule(call("PATCH", "{}", noType), "a", deps)).status).toBe(415);
    });

    it.each(["{", "undefined", "{'a':1}", '{"a":1}{"b":2}', "\u0000"])(
      "rejects malformed JSON %j with 400",
      async (raw) => {
        expect((await handleSchedule(call("POST", raw), deps)).status).toBe(400);
      },
    );
  });

  describe("ids", () => {
    const ids = [
      "../etc/passwd",
      "..",
      "%2e%2e%2f",
      "a/b",
      " ",
      "\u0000",
      "x".repeat(100_000),
      "' OR 1=1 --",
      "‮\u0000é💥",
      "__proto__",
    ];
    it.each(ids)(
      "answers 404 for an unknown id on reschedule, retry and unschedule (%#)",
      async (id) => {
        expect(
          (await handleReschedule(call("PATCH", JSON.stringify({ date: DATE })), id, deps)).status,
        ).toBe(404);
        expect((await handleRetry(call("POST"), id, deps)).status).toBe(404);
        expect((await handleUnschedule(call("DELETE"), id, deps)).status).toBe(404);
        expect(publisher.calls).toEqual([]);
      },
    );

    it("answers 404 for an empty id", async () => {
      expect((await handleUnschedule(call("DELETE"), "", deps)).status).toBe(404);
    });

    it("does not touch existing rows when a hostile id is used", async () => {
      await handleSchedule(call("POST", JSON.stringify({ workoutId, date: DATE })), deps);
      await handleUnschedule(call("DELETE"), "../", deps);
      expect(await rows()).toBe(1);
    });
  });

  describe("dates", () => {
    it.each([
      "2026-6-20",
      "2026-06-20T00:00:00Z",
      " 2026-06-20",
      "2026-06-20\n",
      "２０２６-06-20",
      "2026-13-01",
      "2026-02-30",
      "0000-00-00",
      "",
      "tomorrow",
      "2026-06-20'; DROP TABLE x;--",
    ])("rejects malformed schedule date %j with 422 and no row", async (date) => {
      expect(
        (await handleSchedule(call("POST", JSON.stringify({ workoutId, date })), deps)).status,
      ).toBe(422);
      expect(await rows()).toBe(0);
    });

    it("rejects dates outside the scheduling window on schedule and reschedule", async () => {
      for (const date of ["1999-01-01", "2099-01-01"]) {
        expect(
          (await handleSchedule(call("POST", JSON.stringify({ workoutId, date })), deps)).status,
        ).toBe(422);
        expect(
          (await handleReschedule(call("PATCH", JSON.stringify({ date })), "a", deps)).status,
        ).toBe(422);
      }
    });

    it("validates the new date before looking up the id on reschedule", async () => {
      const res = await handleReschedule(
        call("PATCH", JSON.stringify({ date: "nope" })),
        "missing",
        deps,
      );
      expect(res.status).toBe(422);
    });
  });

  describe("list query", () => {
    it("rejects from after to", async () => {
      expect((await handleScheduleList(get("?from=2026-06-30&to=2026-06-01"), deps)).status).toBe(
        422,
      );
    });

    it("accepts a range of exactly the maximum and rejects one day more", async () => {
      // 2026-06-01 + 366 days = 2027-06-02
      expect(MAX_LIST_RANGE_DAYS).toBe(366);
      expect((await handleScheduleList(get("?from=2026-06-01&to=2027-06-02"), deps)).status).toBe(
        200,
      );
      expect((await handleScheduleList(get("?from=2026-06-01&to=2027-06-03"), deps)).status).toBe(
        422,
      );
    });

    it.each([
      "",
      "?from=&to=",
      "?from=2026-06-01",
      "?to=2026-06-01",
      "?from=2026-06-01&to=garbage",
      "?from[]=2026-06-01&to=2026-06-02",
      "?from=2026-06-01%00&to=2026-06-02",
      `?from=${"9".repeat(50_000)}&to=2026-06-02`,
    ])("rejects bad query %.60s with 422", async (q) => {
      expect((await handleScheduleList(get(q), deps)).status).toBe(422);
    });

    it("uses the first value of a duplicated parameter deterministically", async () => {
      const res = await handleScheduleList(
        get("?from=2026-06-01&from=garbage&to=2026-06-02&to=nope"),
        deps,
      );
      expect(res.status).toBe(200);
      const bad = await handleScheduleList(
        get("?from=garbage&from=2026-06-01&to=2026-06-02"),
        deps,
      );
      expect(bad.status).toBe(422);
    });

    it("ignores unknown query parameters", async () => {
      const res = await handleScheduleList(
        get("?from=2026-06-01&to=2026-06-30&limit=1&__proto__=x"),
        deps,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
    });

    it("includes both boundary dates and excludes dates outside", async () => {
      for (const date of ["2026-06-19", "2026-06-20", "2026-06-21", "2026-06-22"]) {
        await handleSchedule(call("POST", JSON.stringify({ workoutId, date })), deps);
      }
      const res = await handleScheduleList(get("?from=2026-06-20&to=2026-06-21"), deps);
      const dates = ((await res.json()) as { items: { date: string }[] }).items.map((i) => i.date);
      expect(dates).toEqual(["2026-06-20", "2026-06-21"]);
    });
  });

  describe("csrf, origin and host", () => {
    const body = () => JSON.stringify({ workoutId, date: DATE });
    const mutating = (extra: Record<string, string>) => [
      () => handleSchedule(call("POST", body(), { ...jsonHeaders, ...extra }), deps),
      () =>
        handleReschedule(
          call("PATCH", JSON.stringify({ date: DATE }), { ...jsonHeaders, ...extra }),
          "a",
          deps,
        ),
      () => handleRetry(call("POST", null, { host: HOST, ...extra }), "a", deps),
      () => handleUnschedule(call("DELETE", null, { host: HOST, ...extra }), "a", deps),
    ];

    it.each([
      ["cross-origin", { origin: "http://evil.example" }],
      ["cross-site fetch metadata", { "sec-fetch-site": "cross-site" }],
      ["same-site fetch metadata", { "sec-fetch-site": "same-site" }],
      ["none fetch metadata", { "sec-fetch-site": "none" }],
      ["empty fetch metadata", { "sec-fetch-site": "" }],
      ["unparsable origin", { origin: "not a url" }],
      ["null origin", { origin: "null" }],
      ["empty origin", { origin: "" }],
      ["origin with matching host but other port", { origin: "http://localhost:9999" }],
      ["origin with other scheme-host", { origin: "http://localhost.evil.example:3100" }],
      ["origin with userinfo trick", { origin: "http://localhost:3100@evil.example" }],
      [
        "forged origin but cross-site metadata",
        { origin: `http://${HOST}`, "sec-fetch-site": "cross-site" },
      ],
    ])("blocks every mutating route on %s with 403", async (_n, extra) => {
      for (const run of mutating(extra)) expect((await run()).status).toBe(403);
      expect(publisher.calls).toEqual([]);
      expect(await rows()).toBe(0);
    });

    it("allows same-origin metadata and a matching origin", async () => {
      for (const extra of [{ "sec-fetch-site": "same-origin" }, { origin: `http://${HOST}` }]) {
        expect((await mutating(extra)[0]?.())?.status).toBe(201);
      }
    });

    it("allows a client that sends neither Origin nor Sec-Fetch-Site", async () => {
      expect((await mutating({})[0]?.())?.status).toBe(201);
    });

    it.each([
      "evil.example",
      "localhost.evil.example",
      "evil.example:3100",
      "localhost@evil.example",
      "",
      "[::2]:3100",
    ])("rejects Host %j on reads and mutations with 403", async (host) => {
      expect(
        (await handleScheduleList(get("?from=2026-06-01&to=2026-06-02", { host }), deps)).status,
      ).toBe(403);
      const res = await handleSchedule(call("POST", body(), { ...jsonHeaders, host }), deps);
      expect(res.status).toBe(403);
      expect(await rows()).toBe(0);
    });

    it("rejects a missing Host header", async () => {
      const req = new Request(`http://${HOST}/api/schedule?from=2026-06-01&to=2026-06-02`);
      req.headers.delete("host");
      expect((await handleScheduleList(req, deps)).status).toBe(403);
    });

    it("accepts loopback hosts case-insensitively and configured extra hosts", async () => {
      const ok = (host: string, d: ScheduleRouteDeps = deps) =>
        handleScheduleList(get("?from=2026-06-01&to=2026-06-02", { host }), d);
      expect((await ok("LOCALHOST:3100")).status).toBe(200);
      expect((await ok("[::1]:3100")).status).toBe(200);
      expect((await ok("wrist.example")).status).toBe(403);
      expect(
        (await ok("Wrist.Example", { ...deps, allowedHosts: " wrist.example , other.example" }))
          .status,
      ).toBe(200);
    });

    it("answers 403 and not a body-dependent error when CSRF fails with a malformed body", async () => {
      const res = await handleSchedule(
        call("POST", "{", { ...jsonHeaders, origin: "http://evil.example" }),
        deps,
      );
      expect(res.status).toBe(403);
    });
  });

  describe("method mismatch", () => {
    it("lets a mutating verb on the list handler read only (no body consumed, no writes)", async () => {
      const res = await handleScheduleList(
        new Request(`http://${HOST}/api/schedule?from=2026-06-01&to=2026-06-02`, {
          method: "DELETE",
          headers: { host: HOST },
        }),
        deps,
      );
      expect(res.status).toBe(200);
      expect(await rows()).toBe(0);
    });
  });

  describe("error mapping and leak resistance", () => {
    const attempts = (d: ScheduleRouteDeps) => [
      () => handleSchedule(call("POST", JSON.stringify({ workoutId, date: DATE })), d),
      () => handleReschedule(call("PATCH", JSON.stringify({ date: DATE })), "a", d),
      () => handleRetry(call("POST"), "a", d),
      () => handleUnschedule(call("DELETE"), "a", d),
      () => handleScheduleList(get("?from=2026-06-01&to=2026-06-02"), d),
    ];

    it.each([
      "PublisherWeirdError",
      "",
      "SchedulePublishError",
      "publisherratelimiterror",
      ` ${SECRET}`,
      "Error: boom",
    ])("maps an unexpected publish reason %j to 502 without echoing it", async (reason) => {
      const fail = () => Promise.reject(new SchedulePublishError(`${reason}${SECRET}`));
      const d = stub({
        schedule: fail,
        reschedule: fail,
        retry: fail,
        unschedule: fail,
        list: fail,
      });
      for (const run of attempts(d)) {
        const res = await run();
        expect(res.status).toBe(502);
        const text = await textOf(res);
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain("SchedulePublishError");
        expect(JSON.parse(text)).toEqual({ error: "publishing to intervals.icu failed" });
      }
    });

    it("maps an auth failure to 502 and rate limiting to 429 using only the typed kind", async () => {
      const mk = (error: SchedulePublishError) => stub({ schedule: () => Promise.reject(error) });
      const run = (error: SchedulePublishError) =>
        handleSchedule(call("POST", JSON.stringify({ workoutId, date: DATE })), mk(error));
      const auth = await run(new SchedulePublishError("PublisherAuthError (401)", "auth"));
      expect(auth.status).toBe(502);
      expect(await auth.json()).toEqual({ error: "intervals.icu rejected the credentials" });
      const limited = await run(
        new SchedulePublishError("PublisherRateLimitError (429)", "rate-limit"),
      );
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({
        error: "intervals.icu rate limit reached; retry later",
      });
      const other = await run(new SchedulePublishError("PublisherTransientError (503)", "other"));
      expect(other.status).toBe(502);
      expect(await other.json()).toEqual({ error: "publishing to intervals.icu failed" });
    });

    it("ignores a rate-limit looking reason when the kind is other or missing", async () => {
      const looksLimited = "PublisherRateLimitError (429)";
      const missing = Object.assign(new SchedulePublishError(looksLimited), { kind: undefined });
      const bogus = Object.assign(new SchedulePublishError(looksLimited), { kind: "nope" });
      for (const error of [new SchedulePublishError(looksLimited, "other"), missing, bogus]) {
        const res = await handleSchedule(
          call("POST", JSON.stringify({ workoutId, date: DATE })),
          stub({ schedule: () => Promise.reject(error) }),
        );
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "publishing to intervals.icu failed" });
      }
    });

    it("maps ScheduleForeignEventError to a fixed 409", async () => {
      const fail = () => Promise.reject(new ScheduleForeignEventError());
      const res = await handleUnschedule(call("DELETE"), "a", stub({ unschedule: fail }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "remote event was not created by wristplan" });
    });

    it.each([
      ["Error", () => new Error(`token ${SECRET}`)],
      ["TypeError with stack", () => new TypeError(`bad ${SECRET}`)],
      ["Error with cause", () => new Error("outer", { cause: new Error(SECRET) })],
      ["string", () => SECRET],
      ["object", () => ({ message: SECRET, stack: SECRET })],
      ["null", () => null],
      ["error whose name is the secret", () => Object.assign(new Error("x"), { name: "Plain" })],
      [
        "rejected PublisherAuthError subclass impostor",
        () => Object.assign(new Error(SECRET), { status: 401 }),
      ],
    ])(
      "maps an unknown %s to a generic 500 with no message, stack or secret anywhere",
      async (_n, make) => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const boom = () => {
          throw make();
        };
        const d: ScheduleRouteDeps = { readService: boom, service: boom };
        for (const run of attempts(d)) {
          const res = await run();
          expect(res.status).toBe(500);
          const text = await textOf(res);
          expect(JSON.parse(text)).toEqual({ error: "internal error" });
          expect(text).not.toMatch(/SECRET|stack|\bat \w|node_modules/);
          expect(res.headers.get("cache-control")).toBe("no-store");
        }
        const logged = JSON.stringify([spy.mock.calls, log.mock.calls, warn.mock.calls]);
        expect(logged).not.toContain(SECRET);
        expect(logged).not.toMatch(/\bat .*\(/);
      },
    );

    it("maps an unknown error thrown asynchronously by the service the same way", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const d = stub({ unschedule: () => Promise.reject(new Error(SECRET)) });
      const res = await handleUnschedule(call("DELETE"), "a", d);
      expect(res.status).toBe(500);
      expect(await textOf(res)).not.toContain(SECRET);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    });

    it("does not leak a database error message for a failing store", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(t.db.scheduledWorkout, "findMany").mockRejectedValue(
        new Error(`db ${SECRET} /Users/x/ci.db`),
      );
      const res = await handleScheduleList(get("?from=2026-06-01&to=2026-06-02"), deps);
      expect(res.status).toBe(500);
      expect(await textOf(res)).not.toMatch(/SECRET|ci\.db|Users/);
    });

    it("keeps the stored lastError to the error class even if the publisher throws a secret", async () => {
      publisher.failNext("publish", new PublisherAuthError(401));
      const res = await handleSchedule(
        call("POST", JSON.stringify({ workoutId, date: DATE })),
        deps,
      );
      const text = await textOf(res);
      expect(res.status).toBe(201);
      expect(text).toContain("PublisherAuthError (401)");
      expect(text).not.toMatch(/credentials|SECRET/);
    });
  });

  describe("not configured", () => {
    const noKey: () => ScheduleRouteDeps = () => ({
      readService: () => service,
      service: () => {
        throw new ScheduleNotConfiguredError();
      },
    });

    it("returns 503 and leaves no pending row or publisher call when scheduling without a key", async () => {
      const res = await handleSchedule(
        call("POST", JSON.stringify({ workoutId, date: DATE })),
        noKey(),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "intervals.icu is not configured" });
      expect(await rows()).toBe(0);
      expect(publisher.calls).toEqual([]);
    });

    it("returns 503 without a key even when the body is malformed, and writes nothing", async () => {
      for (const raw of ["{", "null"]) {
        expect((await handleSchedule(call("POST", raw), noKey())).status).toBe(503);
      }
      expect(await rows()).toBe(0);
    });

    it("does not alter an existing row when retry, reschedule or unschedule run without a key", async () => {
      const made = (await (
        await handleSchedule(call("POST", JSON.stringify({ workoutId, date: DATE })), deps)
      ).json()) as { id: string };
      const before = await t.db.scheduledWorkout.findMany();
      const d = noKey();
      expect((await handleRetry(call("POST"), made.id, d)).status).toBe(503);
      expect(
        (await handleReschedule(call("PATCH", JSON.stringify({ date: "2026-06-21" })), made.id, d))
          .status,
      ).toBe(503);
      expect((await handleUnschedule(call("DELETE"), made.id, d)).status).toBe(503);
      expect(await t.db.scheduledWorkout.findMany()).toEqual(before);
    });

    it("lists existing rows without a key", async () => {
      await handleSchedule(call("POST", JSON.stringify({ workoutId, date: DATE })), deps);
      const res = await handleScheduleList(get("?from=2026-06-01&to=2026-06-30"), noKey());
      expect(res.status).toBe(200);
      expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
    });

    it("never calls service() on the read path", async () => {
      const serviceFn = vi.fn(() => {
        throw new ScheduleNotConfiguredError();
      });
      const res = await handleScheduleList(get("?from=2026-06-01&to=2026-06-30"), {
        readService: () => service,
        service: serviceFn,
      });
      expect(res.status).toBe(200);
      expect(serviceFn).not.toHaveBeenCalled();
    });
  });
});
