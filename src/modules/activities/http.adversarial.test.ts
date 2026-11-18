import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { rejectCrossOrigin } from "../../lib/http";
import type { GarminClient } from "../garmin";
import { handleFitDownload, handleSync } from "./index";

const HOST = "localhost:3000";
const req = (headers: Record<string, string> = {}, method = "POST") =>
  new Request(`http://${HOST}/api/sync`, { method, headers });

describe("rejectCrossOrigin adversarial", () => {
  it.each([
    ["different port", { host: HOST, origin: "http://localhost:3001" }],
    ["trailing-dot host", { host: HOST, origin: "http://localhost.:3000" }],
    ["suffix host", { host: HOST, origin: "http://localhost:3000.evil.example" }],
    ["unparseable origin", { host: HOST, origin: "not a url" }],
    ["empty origin", { host: HOST, origin: "" }],
    ["origin without host header", { origin: `http://${HOST}` }],
    ["cross-site without origin", { host: HOST, "sec-fetch-site": "cross-site" }],
    ["empty sec-fetch-site", { host: HOST, "sec-fetch-site": "" }],
    [
      "same-origin sec-fetch but foreign origin",
      { host: HOST, "sec-fetch-site": "same-origin", origin: "http://evil.example" },
    ],
  ])("rejects %s", (_n, headers) => {
    expect(rejectCrossOrigin(req(headers))?.status).toBe(403);
  });

  it("does not leak details in the rejection body", async () => {
    const res = rejectCrossOrigin(req({ host: HOST, origin: "http://evil.example" }));
    expect(await res?.json()).toEqual({ error: "forbidden" });
    expect(res?.headers.get("cache-control")).toBe("no-store");
  });
});

describe("handleSync adversarial", () => {
  const db = () => ({}) as never;

  it.each(["GET", "HEAD", "PUT", "DELETE", "PATCH"])(
    "rejects %s without doing work",
    async (method) => {
      const sync = vi.fn();
      const g = vi.fn();
      const res = await handleSync(req({ host: HOST }, method), { db, garmin: g, sync });
      expect(res.status).toBe(405);
      expect(g).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    },
  );

  it("does not run sync for a cross-site POST even with a matching Host", async () => {
    const sync = vi.fn();
    const res = await handleSync(req({ host: HOST, "sec-fetch-site": "cross-site" }), {
      db,
      garmin: () => ({}) as GarminClient,
      sync,
    });
    expect(res.status).toBe(403);
    expect(sync).not.toHaveBeenCalled();
  });

  it("returns a generic 500 and logs only the error name", async () => {
    const spies = (["log", "warn", "info"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sync = vi.fn().mockRejectedValue(new Error("SELECT * FROM Activity; key=fake-key-1"));
    const res = await handleSync(req({ host: HOST }), {
      db,
      garmin: () => ({}) as GarminClient,
      sync,
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "sync failed" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(errSpy.mock.calls).toEqual([["sync failed: Error"]]);
    vi.restoreAllMocks();
  });

  it("treats a thrown non-Error value as a generic 500", async () => {
    const sync = vi.fn().mockRejectedValue("fake-key-1");
    const res = await handleSync(req({ host: HOST }), {
      db,
      garmin: () => ({}) as GarminClient,
      sync,
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("fake-key-1");
  });
});

describe("handleFitDownload adversarial", () => {
  let t: TestDb;
  const big = new Uint8Array(70_000).map((_, i) => i % 251);
  beforeEach(async () => {
    t = createTestDb();
    const base = { startTime: new Date(0), lastSyncedAt: new Date(0) };
    await t.db.activity.create({ data: { garminActivityId: "1001", fitFile: big, ...base } });
    await t.db.activity.create({ data: { garminActivityId: "1002", ...base } });
  });
  afterEach(() => t.cleanup());

  it("reports a Content-Length equal to the body size", async () => {
    const res = await handleFitDownload(req({ host: HOST }, "GET"), "1001", t.db);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get("content-length")).toBe("70000");
    expect(body.byteLength).toBe(70_000);
    expect(body[250]).toBe(250);
    expect(body[251]).toBe(0);
  });

  it.each([
    "01001",
    "99999999999999999999999999",
    "١٠٠١",
    "%2e%2e",
    "%31%30%30%31",
    " 1001",
    "1001 ",
    "1001\n",
    "1001\r\nX-Evil: 1",
    "1001,1002",
    "[1001]",
    "1001.fit",
    "-1001",
    "1e3",
  ])("404 for %j", async (id) => {
    expect((await handleFitDownload(req({ host: HOST }, "GET"), id, t.db)).status).toBe(404);
  });

  it("gives identical 404 responses for missing activity and activity without FIT", async () => {
    const a = await handleFitDownload(req({ host: HOST }, "GET"), "1002", t.db);
    const b = await handleFitDownload(req({ host: HOST }, "GET"), "424242", t.db);
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });

  it("only selects the fitFile column", async () => {
    const spy = vi.spyOn(t.db.activity, "findUnique");
    await handleFitDownload(req({ host: HOST }, "GET"), "1001", t.db);
    expect(spy).toHaveBeenCalledWith({
      where: { garminActivityId: "1001" },
      select: { fitFile: true },
    });
  });

  it.each(["abc", "1001abc", "1001.fit"])("does not query the database for %j", async (id) => {
    const spy = vi.spyOn(t.db.activity, "findUnique");
    await handleFitDownload(req({ host: HOST }, "GET"), id, t.db);
    expect(spy).not.toHaveBeenCalled();
  });
});
