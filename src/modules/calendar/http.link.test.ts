import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { MAX_BODY_BYTES } from "../../lib/http";
import { createWorkoutRepository } from "../workouts";
import { createLinkService, handleLink, handleUnlink, type LinkRouteDeps } from "./index";

const HOST = "127.0.0.1:3100";
const SECRET = "FAKE-SECRET-1111";
const jsonHeaders = { host: HOST, "content-type": "application/json" };
const put = (body: unknown, headers: Record<string, string> = jsonHeaders) =>
  new Request(`http://${HOST}/x`, {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  });
const del = (headers: Record<string, string> = { host: HOST }) =>
  new Request(`http://${HOST}/x`, { method: "DELETE", headers });
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("link handlers", () => {
  let t: TestDb;
  let deps: LinkRouteDeps;
  beforeEach(async () => {
    t = createTestDb();
    deps = { linkService: () => createLinkService({ db: t.db }) };
    const w = await createWorkoutRepository(t.db).create({
      name: "Easy run",
      sport: "run",
      steps: [
        { kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 1 } },
      ],
    });
    for (const [id, date] of [
      ["s1", "2026-06-16"],
      ["s2", "2026-06-17"],
    ] as const) {
      await t.db.scheduledWorkout.create({
        data: { id, workoutId: w.id, date, status: "pending", externalId: `wristplan-${id}` },
      });
    }
    await t.db.activity.create({
      data: { garminActivityId: "111", startTime: new Date(0), lastSyncedAt: new Date(0) },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.cleanup();
  });

  it("links, marks no match and unlinks", async () => {
    const linked = await handleLink(put({ garminActivityId: "111" }), "s1", deps);
    expect(linked.status).toBe(200);
    expect(linked.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(linked)).toMatchObject({
      id: "s1",
      linkedGarminActivityId: "111",
      matchSource: "manual",
    });
    expect(await bodyOf(await handleLink(put({ none: true }), "s1", deps))).toMatchObject({
      linkedGarminActivityId: null,
      matchSource: "none",
    });
    expect(await bodyOf(await handleUnlink(del(), "s1", deps))).toMatchObject({
      linkedGarminActivityId: null,
      matchSource: null,
    });
  });

  it("returns 404 for unknown schedule and activity", async () => {
    const a = await handleLink(put({ garminActivityId: "111" }), "nope", deps);
    expect(a.status).toBe(404);
    expect(await bodyOf(a)).toEqual({ error: "not found" });
    const b = await handleLink(put({ garminActivityId: "999" }), "s1", deps);
    expect(b.status).toBe(404);
    expect(await bodyOf(b)).toEqual({ error: "activity not found" });
    expect((await handleLink(put({ none: true }), "nope", deps)).status).toBe(404);
    expect((await handleUnlink(del(), "nope", deps)).status).toBe(404);
  });

  it("returns 409 when the activity is linked to another plan", async () => {
    await handleLink(put({ garminActivityId: "111" }), "s1", deps);
    expect((await handleLink(put({ garminActivityId: "111" }), "s2", deps)).status).toBe(409);
  });

  it.each([
    ["empty object", {}],
    ["both fields", { garminActivityId: "111", none: true }],
    ["none false", { none: false }],
    ["none string", { none: "true" }],
    ["number id", { garminActivityId: 111 }],
    ["null id", { garminActivityId: null }],
    ["extra key", { garminActivityId: "111", x: 1 }],
    ["traversal id", { garminActivityId: "../x" }],
    ["proto id", { garminActivityId: "__proto__" }],
    ["array", ["111"]],
    ["null", null],
    ["string", "111"],
  ])("returns 422 for %s", async (_name, body) => {
    const res = await handleLink(put(body), "s1", deps);
    expect(res.status).toBe(422);
  });

  it("rejects a __proto__ key body and an oversized body", async () => {
    expect((await handleLink(put('{"__proto__":{"none":true}}'), "s1", deps)).status).toBe(422);
    const huge = put(JSON.stringify({ garminActivityId: "1".repeat(MAX_BODY_BYTES) }));
    expect((await handleLink(huge, "s1", deps)).status).toBe(413);
  });

  it("rejects bad host and cross-site requests", async () => {
    const evil = { ...jsonHeaders, host: "evil.example" };
    expect((await handleLink(put({ none: true }, evil), "s1", deps)).status).toBe(403);
    expect((await handleUnlink(del({ host: "evil.example" }), "s1", deps)).status).toBe(403);
    const cross = { ...jsonHeaders, "sec-fetch-site": "cross-site" };
    expect((await handleLink(put({ none: true }, cross), "s1", deps)).status).toBe(403);
    expect(
      (await handleUnlink(del({ host: HOST, origin: "http://evil.example" }), "s1", deps)).status,
    ).toBe(403);
    expect(await t.db.scheduledWorkout.count({ where: { matchSource: { not: null } } })).toBe(0);
  });

  it("never echoes an unexpected error message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const boom: LinkRouteDeps = {
      linkService: () => {
        throw new Error(SECRET);
      },
    };
    for (const res of [
      await handleLink(put({ none: true }), "s1", boom),
      await handleUnlink(del(), "s1", boom),
    ]) {
      expect(res.status).toBe(500);
      expect(JSON.stringify(await bodyOf(res))).not.toContain(SECRET);
    }
  });

  it("needs no intervals.icu configuration: only the link service is consulted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const onlyLinks: LinkRouteDeps = { linkService: deps.linkService };
    expect((await handleLink(put({ none: true }), "s1", onlyLinks)).status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
