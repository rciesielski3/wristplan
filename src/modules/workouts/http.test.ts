import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import {
  createWorkoutRepository,
  handleCreate,
  handleDelete,
  handleDuplicate,
  handleGet,
  handleList,
  handleText,
  handleUpdate,
  handleUseTemplate,
  MAX_BODY_BYTES,
  WorkoutCorruptError,
  type WorkoutRepository,
  type WorkoutRouteDeps,
} from "./index";

const HOST = "127.0.0.1:3100";
const workout = (name = "Easy run") => ({
  name,
  sport: "run",
  steps: [
    { kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 2 } },
    {
      kind: "repeat",
      times: 3,
      steps: [
        { kind: "work", end: { type: "time", seconds: 180 }, target: { type: "hr", zone: 4 } },
        { kind: "recovery", end: { type: "time", seconds: 120 }, target: { type: "hr", zone: 2 } },
      ],
    },
  ],
});

const req = (method: string, path = "/api/workouts", init: RequestInit = {}) =>
  new Request(`http://${HOST}${path}`, {
    method,
    ...init,
    headers: { host: HOST, ...(init.headers as Record<string, string> | undefined) },
  });
const post = (body: unknown, extra: Record<string, string> = {}) =>
  req("POST", "/api/workouts", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...extra },
  });

describe("workout handlers", () => {
  let t: TestDb;
  let deps: WorkoutRouteDeps;
  let repo: WorkoutRepository;
  beforeEach(() => {
    t = createTestDb();
    repo = createWorkoutRepository(t.db);
    deps = { repo: () => repo };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.cleanup();
  });

  it("creates, gets, lists, updates and deletes", async () => {
    const created = await handleCreate(post(workout()), deps);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const { id } = (await created.json()) as { id: string };

    const got = await handleGet(req("GET"), id, deps);
    expect(((await got.json()) as { workout: { name: string } }).workout.name).toBe("Easy run");

    const list = await handleList(req("GET"), deps);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);

    const put = new Request(`http://${HOST}/x`, {
      method: "PUT",
      body: JSON.stringify(workout("Renamed")),
      headers: { host: HOST, "content-type": "application/json; charset=utf-8" },
    });
    const updated = await handleUpdate(put, id, deps);
    expect(((await updated.json()) as { workout: { name: string } }).workout.name).toBe("Renamed");

    expect((await handleDelete(req("DELETE"), id, deps)).status).toBe(200);
    expect((await handleGet(req("GET"), id, deps)).status).toBe(404);
    expect((await handleDelete(req("DELETE"), id, deps)).status).toBe(404);
  });

  it("filters the list by templates flag", async () => {
    const a = await repo.create(workout("A"));
    await repo.duplicate(a.id, { asTemplate: true });
    const names = async (q: string) =>
      (
        (await (await handleList(req("GET", `/api/workouts${q}`), deps)).json()) as {
          items: { isTemplate: boolean }[];
        }
      ).items.map((i) => i.isTemplate);
    expect(await names("?templates=true")).toEqual([true]);
    expect(await names("?templates=false")).toEqual([false]);
    expect(await names("")).toHaveLength(2);
  });

  it("duplicates, saves as template and uses a template", async () => {
    const a = await repo.create(workout("A"));
    const dup = await handleDuplicate(req("POST"), a.id, deps);
    expect(dup.status).toBe(201);
    expect(((await dup.json()) as { workout: { name: string } }).workout.name).toBe("A (copy)");

    const tpl = await handleDuplicate(req("POST", "/x?asTemplate=true"), a.id, deps);
    const tplBody = (await tpl.json()) as { id: string; isTemplate: boolean };
    expect(tplBody.isTemplate).toBe(true);

    const used = await handleUseTemplate(req("POST"), tplBody.id, deps);
    expect(used.status).toBe(201);
    expect(((await used.json()) as { isTemplate: boolean }).isTemplate).toBe(false);

    expect((await handleUseTemplate(req("POST"), a.id, deps)).status).toBe(409);
    expect((await handleDuplicate(req("POST"), "nope", deps)).status).toBe(404);
  });

  it("returns the intervals text preview as text/plain", async () => {
    const a = await repo.create(workout());
    const res = await handleText(req("GET"), a.id, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("Warmup\n- 10m Z2 HR\n\nMain set 3x\n- 3m Z4 HR\n- 2m Z2 HR");
    expect((await handleText(req("GET"), "../etc", deps)).status).toBe(404);
  });

  it("maps validation errors to 422 with path and message only", async () => {
    const res = await handleCreate(post({ ...workout(), steps: [] }), deps);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: Record<string, unknown>[] };
    expect(body.issues[0]).toEqual({
      path: "steps",
      message: "a workout needs at least one step",
    });
    const put = await handleUpdate(
      req("PUT", "/x", {
        body: "[]",
        headers: { "content-type": "application/json" },
      }),
      "abc",
      deps,
    );
    expect(put.status).toBe(422);
  });

  it("rejects bad content type, bad JSON and oversized bodies", async () => {
    const noType = req("POST", "/x", { body: "{}", headers: { "content-type": "text/plain" } });
    expect((await handleCreate(noType, deps)).status).toBe(415);
    expect((await handleCreate(req("POST"), deps)).status).toBe(415);
    expect((await handleCreate(post("{nope"), deps)).status).toBe(400);
    expect((await handleCreate(post(""), deps)).status).toBe(400);
    const noBody = req("POST", "/x", { headers: { "content-type": "application/json" } });
    expect((await handleCreate(noBody, deps)).status).toBe(400);

    const big = JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) });
    expect((await handleCreate(post(big), deps)).status).toBe(413);
    const declared = post("{}", { "content-length": String(MAX_BODY_BYTES + 1) });
    expect((await handleCreate(declared, deps)).status).toBe(413);
  });

  it("enforces Host on reads and Host + CSRF on mutations", async () => {
    const evilHost = new Request("http://evil.example/api/workouts", {
      headers: { host: "evil.example" },
    });
    expect((await handleList(evilHost, deps)).status).toBe(403);
    expect((await handleGet(evilHost, "abc", deps)).status).toBe(403);
    expect((await handleText(evilHost, "abc", deps)).status).toBe(403);

    for (const extra of [{ origin: "http://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
      expect((await handleCreate(post(workout(), extra), deps)).status).toBe(403);
    }
    expect(
      (
        await handleDelete(
          req("DELETE", "/x", { headers: { origin: "http://evil.example" } }),
          "a",
          deps,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleDuplicate(
          req("POST", "/x", { headers: { "sec-fetch-site": "cross-site" } }),
          "a",
          deps,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleUseTemplate(
          req("POST", "/x", { headers: { "sec-fetch-site": "cross-site" } }),
          "a",
          deps,
        )
      ).status,
    ).toBe(403);
    expect(
      (await handleUpdate(post(workout(), { origin: "http://evil.example" }), "a", deps)).status,
    ).toBe(403);
    expect(await repo.list()).toMatchObject({ items: [] });

    const withExtra = { ...deps, allowedHosts: "box.lan" };
    const lan = new Request("http://box.lan/api/workouts", { headers: { host: "box.lan" } });
    expect((await handleList(lan, withExtra)).status).toBe(200);
  });

  it("returns 409 for corrupt rows and generic 500 without leaking details", async () => {
    const corrupt = {
      ...repo,
      get: () => Promise.reject(new WorkoutCorruptError("abc")),
    } as WorkoutRepository;
    const res = await handleGet(req("GET"), "abc", { repo: () => corrupt });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stored workout is corrupt" });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = {
      ...repo,
      list: () => Promise.reject(new Error("secret db path /home/x")),
    } as WorkoutRepository;
    const failed = await handleList(req("GET"), { repo: () => boom });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "internal error" });
    expect(spy).toHaveBeenCalledWith("workout request failed: Error");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");

    const odd = { ...repo, list: () => Promise.reject("str") } as unknown as WorkoutRepository;
    await handleList(req("GET"), { repo: () => odd });
    expect(spy).toHaveBeenCalledWith("workout request failed: UnknownError");
  });
});
