import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import {
  createWorkoutRepository,
  handleCreate,
  handleDelete,
  handleDuplicate,
  handleGet,
  handleText,
  handleUseTemplate,
  MAX_BODY_BYTES,
  MAX_ISSUES,
  WorkoutCorruptError,
  WorkoutNotFoundError,
  type WorkoutRepository,
  type WorkoutRouteDeps,
  WorkoutValidationError,
} from "./index";

const HOST = "localhost:3100";
const valid = {
  name: "Easy",
  sport: "run",
  steps: [{ kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 2 } }],
};
const jsonHeaders = { host: HOST, "content-type": "application/json" };
const post = (body: BodyInit | null, headers: Record<string, string> = jsonHeaders, init = {}) =>
  new Request(`http://${HOST}/api/workouts`, { method: "POST", body, headers, ...init });
const bodyOfSize = (bytes: number): string => {
  const base = JSON.stringify({ ...valid, name: "" });
  return JSON.stringify({ ...valid, name: "x".repeat(bytes - base.length) });
};

describe("workout handlers under hostile input", () => {
  let t: TestDb;
  let repo: WorkoutRepository;
  let deps: WorkoutRouteDeps;
  beforeEach(() => {
    t = createTestDb();
    repo = createWorkoutRepository(t.db);
    deps = { repo: () => repo };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.cleanup();
  });
  const count = async () => (await repo.list()).items.length;

  describe("body size", () => {
    it("treats a body of exactly the cap as within limits and one byte more as too large", async () => {
      const exact = bodyOfSize(MAX_BODY_BYTES);
      expect(exact.length).toBe(MAX_BODY_BYTES);
      // 100-char name limit makes this a 422, which proves the size gate let it through.
      expect((await handleCreate(post(exact), deps)).status).toBe(422);
      expect((await handleCreate(post(`${exact} `), deps)).status).toBe(413);
    });

    it("accepts a declared length of exactly the cap", async () => {
      const exact = bodyOfSize(MAX_BODY_BYTES);
      const headers = { ...jsonHeaders, "content-length": String(MAX_BODY_BYTES) };
      expect((await handleCreate(post(exact, headers), deps)).status).toBe(422);
    });

    it("rejects an oversized declared length without reading the body", async () => {
      const res = await handleCreate(
        post("{}", { ...jsonHeaders, "content-length": String(MAX_BODY_BYTES + 1) }),
        deps,
      );
      expect(res.status).toBe(413);
    });

    it("rejects a streamed body over the cap when no length is declared", async () => {
      const chunk = new TextEncoder().encode("x".repeat(1024));
      let sent = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += 1;
          controller.enqueue(chunk);
          if (sent > 10_000) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      const res = await handleCreate(post(stream, jsonHeaders, { duplex: "half" }), deps);
      expect(res.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(sent).toBeLessThan(200);
    });

    it("rejects a big body behind a lying small content-length", async () => {
      const lying = { ...jsonHeaders, "content-length": "2" };
      const res = await handleCreate(post(bodyOfSize(MAX_BODY_BYTES + 10), lying), deps);
      expect(res.status).toBe(413);
    });

    it("ignores a non-numeric content-length and still enforces the streamed cap", async () => {
      const junk = { ...jsonHeaders, "content-length": "abc" };
      expect((await handleCreate(post(bodyOfSize(MAX_BODY_BYTES + 10), junk), deps)).status).toBe(
        413,
      );
      expect((await handleCreate(post(JSON.stringify(valid), junk), deps)).status).toBe(201);
    });
  });

  describe("content type and JSON", () => {
    it.each([
      "application/json",
      "Application/JSON",
      "application/json; charset=utf-8",
      " application/json ;charset=UTF-8",
    ])("accepts %j", async (type) => {
      const res = await handleCreate(
        post(JSON.stringify(valid), { host: HOST, "content-type": type }),
        deps,
      );
      expect(res.status).toBe(201);
    });

    it.each(["text/plain", "application/x-www-form-urlencoded", "application/jsonx", "json", ""])(
      "rejects %j with 415 and stores nothing",
      async (type) => {
        const res = await handleCreate(
          post(JSON.stringify(valid), { host: HOST, "content-type": type }),
          deps,
        );
        expect(res.status).toBe(415);
        expect(await count()).toBe(0);
      },
    );

    it("rejects a UTF-8 BOM and invalid UTF-8 as 400, not 500", async () => {
      expect((await handleCreate(post(`﻿${JSON.stringify(valid)}`), deps)).status).toBe(400);
      expect((await handleCreate(post(new Uint8Array([0x7b, 0xff, 0x7d])), deps)).status).toBe(400);
    });

    it("answers deeply nested JSON with a client error, never 500", async () => {
      const deep = "[".repeat(30_000) + "]".repeat(30_000);
      const res = await handleCreate(post(deep), deps);
      expect([400, 422]).toContain(res.status);
    });

    it.each(["null", "42", '"str"', "true", "[]", "[1]"])(
      "rejects non-object root %s with 422",
      async (raw) => expect((await handleCreate(post(raw), deps)).status).toBe(422),
    );

    it("does not pollute prototypes through __proto__ and stores nothing", async () => {
      const raw = `{"__proto__":{"polluted":1},"name":"x","sport":"run","steps":[]}`;
      const res = await handleCreate(post(raw), deps);
      expect(res.status).toBe(422);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(await count()).toBe(0);
    });

    it("rejects 51 top-level steps and accepts 50", async () => {
      const step = valid.steps[0];
      const many = (n: number) => ({ ...valid, steps: Array.from({ length: n }, () => step) });
      expect((await handleCreate(post(JSON.stringify(many(51))), deps)).status).toBe(422);
      expect((await handleCreate(post(JSON.stringify(many(50))), deps)).status).toBe(201);
    });
  });

  describe("422 issue disclosure", () => {
    it("never echoes submitted values back", async () => {
      const secret = "zzSECRETzz";
      const bad = { ...valid, sport: secret, extra: secret, name: 5, steps: [{ kind: secret }] };
      const res = await handleCreate(post(JSON.stringify(bad)), deps);
      expect(res.status).toBe(422);
      const text = await res.text();
      expect(text).not.toContain(secret);
    });

    it("exposes only path and message per issue", async () => {
      const res = await handleCreate(post(JSON.stringify({ ...valid, steps: [] })), deps);
      const body = (await res.json()) as { issues: object[] };
      for (const issue of body.issues)
        expect(Object.keys(issue).sort()).toEqual(["message", "path"]);
    });

    it("caps the number and size of issues for a body full of invalid repeats", async () => {
      const repeat = { kind: "repeat", times: "x", steps: Array.from({ length: 10 }, () => ({})) };
      const raw = JSON.stringify({ ...valid, steps: Array.from({ length: 50 }, () => repeat) });
      const res = await handleCreate(post(raw), deps);
      expect(res.status).toBe(422);
      const text = await res.text();
      expect((JSON.parse(text) as { issues: unknown[] }).issues).toHaveLength(MAX_ISSUES);
      expect(text.length).toBeLessThan(MAX_ISSUES * 2 * 300 + 100);
    });

    it("truncates very long issue messages", async () => {
      const long = "k".repeat(5000);
      const failing = {
        repo: () =>
          ({
            create: () =>
              Promise.reject(new WorkoutValidationError([{ path: long, message: long }])),
          }) as unknown as WorkoutRepository,
      };
      const res = await handleCreate(post("{}"), failing);
      const body = (await res.json()) as { issues: { path: string; message: string }[] };
      expect(body.issues[0]?.path.length).toBe(300);
      expect(body.issues[0]?.message.length).toBe(300);
    });
  });

  describe("status mapping", () => {
    const failing = (error: unknown): WorkoutRouteDeps => ({
      repo: () =>
        ({
          get: () => Promise.reject(error),
          delete: () => Promise.reject(error),
          duplicate: () => Promise.reject(error),
          createFromTemplate: () => Promise.reject(error),
        }) as unknown as WorkoutRepository,
    });
    const get = (id: string, d: WorkoutRouteDeps) =>
      handleGet(new Request(`http://${HOST}/x`, { headers: { host: HOST } }), id, d);

    it.each(["../etc/passwd", "a b", "x".repeat(65), "", "a%00", "id;drop", "ä"])(
      "answers malformed id %j with 404 on every id route",
      async (id) => {
        const h = { host: HOST };
        const r = (method: string) => new Request(`http://${HOST}/x`, { method, headers: h });
        expect((await get(id, deps)).status).toBe(404);
        expect((await handleDelete(r("DELETE"), id, deps)).status).toBe(404);
        expect((await handleDuplicate(r("POST"), id, deps)).status).toBe(404);
        expect((await handleUseTemplate(r("POST"), id, deps)).status).toBe(404);
        expect((await handleText(r("GET"), id, deps)).status).toBe(404);
      },
    );

    it("maps not-found to 404 and corrupt rows to 409 without detail", async () => {
      const nf = await get("abc", failing(new WorkoutNotFoundError("abc")));
      expect(nf.status).toBe(404);
      const corrupt = await get("abc", failing(new WorkoutCorruptError("abc")));
      expect(corrupt.status).toBe(409);
      expect(JSON.stringify(await corrupt.json())).not.toContain("abc");
    });

    it("answers the text endpoint for a corrupt row with the same 409 as the JSON endpoint", async () => {
      const res = await handleText(
        new Request(`http://${HOST}/x`, { headers: { host: HOST } }),
        "abc",
        failing(new WorkoutCorruptError("abc")),
      );
      expect(res.status).toBe(409);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    });

    it("hides SQL, JSON and stack details of unknown errors and logs only the name", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const leaky = Object.assign(new Error('SELECT * FROM "Workout" {"name":"secret"}'), {
        name: "PrismaClientKnownRequestError",
      });
      const res = await get("abc", failing(leaky));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe('{"error":"internal error"}');
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain("PrismaClientKnownRequestError");
      expect(logged).not.toMatch(/SELECT|secret|stack/);
    });
  });

  describe("text endpoint", () => {
    it("serves user-controlled names as inert text/plain with nosniff", async () => {
      const stored = await repo.create({ ...valid, name: "<script>alert(1)</script>" });
      const res = await handleText(
        new Request(`http://${HOST}/x`, { headers: { host: HOST } }),
        stored.id,
        deps,
      );
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("query flags", () => {
    it("only treats asTemplate=true exactly as a template request", async () => {
      const a = await repo.create(valid);
      const dup = async (q: string) =>
        (
          (await (
            await handleDuplicate(
              new Request(`http://${HOST}/x${q}`, { method: "POST", headers: { host: HOST } }),
              a.id,
              deps,
            )
          ).json()) as { isTemplate: boolean }
        ).isTemplate;
      expect(await dup("?asTemplate=true")).toBe(true);
      expect(await dup("?asTemplate=1")).toBe(false);
      expect(await dup("?asTemplate=TRUE")).toBe(false);
      expect(await dup("")).toBe(false);
    });
  });

  describe("guard coverage on every route", () => {
    const evil = { host: "evil.example" };
    const crossSite = { host: HOST, "sec-fetch-site": "cross-site" };
    const foreignOrigin = { host: HOST, origin: "http://evil.example" };
    const r = (method: string, headers: Record<string, string>) =>
      new Request(`http://${HOST}/x`, { method, headers });
    const mutations = [
      (h: Record<string, string>) => handleCreate(post("{}", { ...jsonHeaders, ...h }), deps),
      (h: Record<string, string>) => handleDelete(r("DELETE", h), "abc", deps),
      (h: Record<string, string>) => handleDuplicate(r("POST", h), "abc", deps),
      (h: Record<string, string>) => handleUseTemplate(r("POST", h), "abc", deps),
    ];

    it.each([evil, crossSite, foreignOrigin])("blocks every mutation for %j", async (headers) => {
      for (const call of mutations) expect((await call(headers)).status).toBe(403);
    });

    it("lets a same-origin mutation through to the handler", async () => {
      const same = { host: HOST, origin: `http://${HOST}`, "sec-fetch-site": "same-origin" };
      expect((await handleDelete(r("DELETE", same), "abc", deps)).status).toBe(404);
    });

    it("blocks reads on a foreign host but does not apply CSRF rules to them", async () => {
      expect((await handleGet(r("GET", evil), "abc", deps)).status).toBe(403);
      expect((await handleGet(r("GET", foreignOrigin), "abc", deps)).status).toBe(404);
    });
  });
});
