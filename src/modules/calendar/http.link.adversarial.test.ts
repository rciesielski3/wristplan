import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { MAX_BODY_BYTES } from "../../lib/http";
import { createWorkoutRepository } from "../workouts";
import {
  createLinkService,
  handleLink,
  handleUnlink,
  type LinkRouteDeps,
  type LinkService,
} from "./index";

const HOST = "localhost:3100";
const SECRET = "FAKE-SECRET-1111";
const jsonHeaders = { host: HOST, "content-type": "application/json" };
const put = (body: BodyInit | null, headers: Record<string, string> = jsonHeaders) =>
  new Request(`http://${HOST}/api/schedule/s1/link`, {
    method: "PUT",
    ...(body === null ? {} : { body }),
    headers,
  });
const del = (headers: Record<string, string> = { host: HOST }, body?: BodyInit) =>
  new Request(`http://${HOST}/api/schedule/s1/link`, {
    method: "DELETE",
    ...(body === undefined ? {} : { body }),
    headers,
  });
const text = (res: Response) => res.text();

describe("link handlers under hostile input", () => {
  let t: TestDb;
  let deps: LinkRouteDeps;
  let service: LinkService;
  beforeEach(async () => {
    t = createTestDb();
    service = createLinkService({ db: t.db });
    deps = { linkService: () => service };
    const w = await createWorkoutRepository(t.db).create({
      name: "Easy run",
      sport: "run",
      steps: [
        { kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 1 } },
      ],
    });
    await t.db.scheduledWorkout.create({
      data: {
        id: "s1",
        workoutId: w.id,
        date: "2026-06-16",
        status: "pending",
        externalId: "wristplan-s1",
      },
    });
    await t.db.activity.create({
      data: { garminActivityId: "111", startTime: new Date(0), lastSyncedAt: new Date(0) },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.cleanup();
  });
  const stored = () =>
    t.db.scheduledWorkout.findUniqueOrThrow({
      where: { id: "s1" },
      select: { linkedGarminActivityId: true, matchSource: true },
    });
  const untouched = async () =>
    expect(await stored()).toEqual({ linkedGarminActivityId: null, matchSource: null });

  describe("csrf, origin and host", () => {
    const run = (extra: Record<string, string>) => [
      () => handleLink(put('{"none":true}', { ...jsonHeaders, ...extra }), "s1", deps),
      () => handleLink(put('{"garminActivityId":"111"}', { ...jsonHeaders, ...extra }), "s1", deps),
      () => handleUnlink(del({ host: HOST, ...extra }), "s1", deps),
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
      ["origin on another port", { origin: "http://localhost:9999" }],
      ["origin with userinfo trick", { origin: "http://localhost:3100@evil.example" }],
      [
        "forged origin with cross-site metadata",
        { origin: `http://${HOST}`, "sec-fetch-site": "cross-site" },
      ],
    ])("blocks link, no-match and unlink on %s with 403 and writes nothing", async (_n, extra) => {
      for (const go of run(extra)) expect((await go()).status).toBe(403);
      await untouched();
    });

    it("blocks a previously linked plan from being unlinked cross-site", async () => {
      await service.linkActivity("s1", "111");
      const res = await handleUnlink(
        del({ host: HOST, "sec-fetch-site": "cross-site" }),
        "s1",
        deps,
      );
      expect(res.status).toBe(403);
      expect(await stored()).toEqual({ linkedGarminActivityId: "111", matchSource: "manual" });
    });

    it.each(["evil.example", "localhost.evil.example", "localhost@evil.example", "", "[::2]:3100"])(
      "rejects Host %j on both handlers with 403",
      async (host) => {
        expect(
          (await handleLink(put('{"none":true}', { ...jsonHeaders, host }), "s1", deps)).status,
        ).toBe(403);
        expect((await handleUnlink(del({ host }), "s1", deps)).status).toBe(403);
        await untouched();
      },
    );

    it("rejects a missing Host header", async () => {
      const req = del();
      req.headers.delete("host");
      expect((await handleUnlink(req, "s1", deps)).status).toBe(403);
    });

    it("accepts same-origin metadata, a matching origin and extra configured hosts", async () => {
      for (const extra of [{ "sec-fetch-site": "same-origin" }, { origin: `http://${HOST}` }, {}]) {
        expect((await run(extra)[0]?.())?.status).toBe(200);
      }
      const other = { ...deps, allowedHosts: "wrist.example" };
      expect((await handleUnlink(del({ host: "Wrist.Example" }), "s1", other)).status).toBe(200);
    });

    it("answers 403 rather than a body error when CSRF fails with a malformed body", async () => {
      const res = await handleLink(
        put("{", { ...jsonHeaders, origin: "http://evil.example" }),
        "s1",
        deps,
      );
      expect(res.status).toBe(403);
    });
  });

  describe("body size, content type and shape", () => {
    it("rejects a declared oversized body with 413 before reading", async () => {
      const res = await handleLink(
        put("{}", { ...jsonHeaders, "content-length": String(MAX_BODY_BYTES + 1) }),
        "s1",
        deps,
      );
      expect(res.status).toBe(413);
    });

    it("rejects an undeclared oversized body with 413 and writes nothing", async () => {
      const big = JSON.stringify({ none: true, pad: "x".repeat(MAX_BODY_BYTES) });
      expect((await handleLink(put(big), "s1", deps)).status).toBe(413);
      await untouched();
    });

    it.each([
      "text/plain",
      "application/jsonp",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "",
    ])("rejects content-type %j with 415 and writes nothing", async (type) => {
      const res = await handleLink(
        put('{"none":true}', { host: HOST, "content-type": type }),
        "s1",
        deps,
      );
      expect(res.status).toBe(415);
      await untouched();
    });

    it("rejects a missing content-type with 415", async () => {
      expect((await handleLink(put('{"none":true}', { host: HOST }), "s1", deps)).status).toBe(415);
    });

    it("accepts content-type parameters and casing", async () => {
      for (const type of ["application/json; charset=utf-8", "Application/JSON"]) {
        const res = await handleLink(
          put('{"none":true}', { host: HOST, "content-type": type }),
          "s1",
          deps,
        );
        expect(res.status).toBe(200);
      }
    });

    it.each(["{", "", "undefined", "{'a':1}", '{"none":true}{"x":1}', "\u0000"])(
      "rejects malformed JSON %j with 400 and writes nothing",
      async (raw) => {
        expect((await handleLink(put(raw), "s1", deps)).status).toBe(400);
        await untouched();
      },
    );

    it.each([
      ["null", "null"],
      ["array", "[]"],
      ["array of objects", '[{"none":true}]'],
      ["number", "5"],
      ["string", '"none"'],
      ["boolean", "true"],
      ["empty object", "{}"],
      ["none as 1", '{"none":1}'],
      ["none as array", '{"none":[true]}'],
      ["none null", '{"none":null}'],
      ["both keys", '{"none":true,"garminActivityId":"111"}'],
      ["extra key", '{"none":true,"x":1}'],
      ["wrong case key", '{"GarminActivityId":"111"}'],
      ["id as array", '{"garminActivityId":["111"]}'],
      ["id as object", '{"garminActivityId":{"equals":"111"}}'],
      ["id as number", '{"garminActivityId":111}'],
      ["id with padding", '{"garminActivityId":" 111"}'],
      ["id zero", '{"garminActivityId":"0"}'],
      ["id negative", '{"garminActivityId":"-1"}'],
      ["id float", '{"garminActivityId":"1.5"}'],
      ["id too long", `{"garminActivityId":"${"1".repeat(17)}"}`],
      ["id arabic digits", '{"garminActivityId":"١٢"}'],
      ["proto key", '{"__proto__":{"none":true}}'],
      ["proto key beside none", '{"none":true,"__proto__":{"x":1}}'],
      ["constructor key", '{"constructor":{"none":true}}'],
    ])("answers 422 for body %s and writes nothing", async (_n, raw) => {
      expect((await handleLink(put(raw), "s1", deps)).status).toBe(422);
      await untouched();
      expect(({} as Record<string, unknown>).none).toBeUndefined();
    });

    it("ignores a body on DELETE", async () => {
      const res = await handleUnlink(
        del({ host: HOST, "content-type": "text/plain" }, "junk"),
        "s1",
        deps,
      );
      expect(res.status).toBe(200);
    });
  });

  describe("ids", () => {
    it.each([
      "../etc/passwd",
      "a/b",
      " ",
      "\u0000",
      "x".repeat(100_000),
      "' OR 1=1 --",
      "__proto__",
      "",
    ])("answers 404 for hostile schedule id %# on all methods and body kinds", async (id) => {
      expect((await handleLink(put('{"none":true}'), id, deps)).status).toBe(404);
      expect((await handleLink(put('{"garminActivityId":"111"}'), id, deps)).status).toBe(404);
      expect((await handleUnlink(del(), id, deps)).status).toBe(404);
      await untouched();
    });
  });

  describe("error mapping and leak resistance", () => {
    it.each([
      [
        "sync throw",
        () => {
          throw new Error(SECRET);
        },
      ],
      ["async rejection", () => Promise.reject(new Error(SECRET))],
      [
        "non-error",
        () => {
          throw SECRET;
        },
      ],
      [
        "prisma-like error",
        () => Promise.reject(Object.assign(new Error(`${SECRET} at /db`), { code: "P1001" })),
      ],
    ])("maps a %s to a generic 500 on every method without echoing it", async (_n, fail) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const boom: LinkRouteDeps = {
        linkService: () => ({ linkActivity: fail, markNoMatch: fail, unlink: fail }) as never,
      };
      for (const res of [
        await handleLink(put('{"none":true}'), "s1", boom),
        await handleLink(put('{"garminActivityId":"111"}'), "s1", boom),
        await handleUnlink(del(), "s1", boom),
      ]) {
        expect(res.status).toBe(500);
        const body = await text(res);
        expect(JSON.parse(body)).toEqual({ error: "internal error" });
        expect(body).not.toContain(SECRET);
        expect(body).not.toContain("/db");
      }
      const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
      expect(logged).not.toContain(SECRET);
    });

    it("answers fixed texts for 404 and 409 without echoing the request", async () => {
      const missing = await handleLink(put('{"garminActivityId":"444"}'), "s1", deps);
      expect(await text(missing)).toBe('{"error":"activity not found"}');
      await t.db.scheduledWorkout.create({
        data: {
          id: "s2",
          workoutId: (await t.db.workout.findFirstOrThrow()).id,
          date: "2026-06-17",
          status: "pending",
          externalId: "wristplan-s2",
        },
      });
      await service.linkActivity("s2", "111");
      const conflict = await handleLink(put('{"garminActivityId":"111"}'), "s1", deps);
      expect(conflict.status).toBe(409);
      expect(await text(conflict)).not.toContain("s2");
    });

    it("sets no-store on success and error responses", async () => {
      for (const res of [
        await handleLink(put('{"none":true}'), "s1", deps),
        await handleLink(put("{"), "s1", deps),
        await handleUnlink(del({ host: "evil.example" }), "s1", deps),
      ]) {
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    });
  });

  describe("independence from intervals.icu", () => {
    it("never calls fetch and builds only the link service", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const linkService = vi.fn(() => service);
      const only = { linkService } satisfies LinkRouteDeps;
      expect((await handleLink(put('{"garminActivityId":"111"}'), "s1", only)).status).toBe(200);
      expect((await handleLink(put('{"none":true}'), "s1", only)).status).toBe(200);
      expect((await handleUnlink(del(), "s1", only)).status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(linkService).toHaveBeenCalledTimes(3);
    });

    it("does not build the service when CSRF, content type or JSON checks fail first", async () => {
      const linkService = vi.fn(() => service);
      const only = { linkService } satisfies LinkRouteDeps;
      await handleLink(
        put('{"none":true}', { ...jsonHeaders, origin: "http://evil.example" }),
        "s1",
        only,
      );
      await handleLink(put("{}", { host: HOST }), "s1", only);
      await handleLink(put("{"), "s1", only);
      await handleUnlink(del({ host: "evil.example" }), "s1", only);
      expect(linkService).not.toHaveBeenCalled();
    });
  });
});
