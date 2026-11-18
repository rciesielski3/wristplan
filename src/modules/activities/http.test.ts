import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { isHostAllowed, rejectCrossOrigin } from "../../lib/http";
import { type GarminClient, GarminConfigError } from "../garmin";
import { handleFitDownload, handleSync } from "./index";
import { SyncInProgressError, type SyncResult } from "./sync";

const HOST = "localhost:3000";
const req = (headers: Record<string, string> = {}, method = "POST") =>
  new Request(`http://${HOST}/api/sync`, { method, headers: { host: HOST, ...headers } });

const result: SyncResult = {
  runId: "run1",
  status: "succeeded",
  imported: 2,
  updated: 1,
  failed: 0,
  errorMessage: null,
};
const garmin = {} as GarminClient;

describe("rejectCrossOrigin", () => {
  it("allows same-origin and header-less requests", () => {
    expect(rejectCrossOrigin(req())).toBeNull();
    expect(rejectCrossOrigin(req({ origin: `http://${HOST}` }))).toBeNull();
    expect(rejectCrossOrigin(req({ "sec-fetch-site": "same-origin" }))).toBeNull();
  });

  it.each([
    { origin: "http://evil.example" },
    { origin: "null" },
    { origin: `http://${HOST}`, "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "none" },
  ])("rejects %j", (headers) => {
    expect(rejectCrossOrigin(req(headers))?.status).toBe(403);
  });
});

describe("host allowlist", () => {
  it.each(["localhost", "localhost:3000", "127.0.0.1:3100", "[::1]:3000", "[::1]", "LOCALHOST"])(
    "allows %s",
    (h) => expect(isHostAllowed(h)).toBe(true),
  );

  it.each([null, "evil.example", "evil.example:3000", "localhost.evil.example", "127.0.0.2", ""])(
    "rejects %j",
    (h) => expect(isHostAllowed(h)).toBe(false),
  );

  it("honours ALLOWED_HOSTS entries", () => {
    expect(isHostAllowed("box.lan:3000", " box.lan , other.lan")).toBe(true);
    expect(isHostAllowed("evil.example", "box.lan")).toBe(false);
  });

  it("blocks DNS rebinding even with a matching Origin", async () => {
    const rebound = req({ host: "evil.example", origin: "http://evil.example" });
    expect(rejectCrossOrigin(rebound)?.status).toBe(403);
    const sync = vi.fn();
    const deps = { db: () => ({}) as never, garmin: vi.fn(), sync };
    expect((await handleSync(rebound, deps)).status).toBe(403);
    expect(sync).not.toHaveBeenCalled();
    expect((await handleSync(rebound, { ...deps, allowedHosts: "evil.example" })).status).not.toBe(
      403,
    );
  });

  it("guards the FIT download and never echoes the host", async () => {
    const res = await handleFitDownload(req({ host: "evil.example" }, "GET"), "1", {} as never);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("evil.example");
  });
});

describe("handleSync", () => {
  const db = () => ({}) as never;

  it("returns the run summary", async () => {
    const sync = vi.fn().mockResolvedValue(result);
    const res = await handleSync(req(), { db, garmin: () => garmin, sync });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(sync).toHaveBeenCalledWith({ garmin, db: expect.anything() });
  });

  it("maps missing config to 503 naming only the variable", async () => {
    const res = await handleSync(req(), {
      db,
      garmin: () => {
        throw new GarminConfigError("GARMIN_PERSONAL_API_KEY");
      },
      sync: vi.fn(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "GARMIN_PERSONAL_API_KEY not configured" });
  });

  it("maps a running sync to 409", async () => {
    const sync = vi.fn().mockRejectedValue(new SyncInProgressError());
    const res = await handleSync(req(), { db, garmin: () => garmin, sync });
    expect(res.status).toBe(409);
  });

  it("logs only the error name for unexpected failures", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new TypeError("secret-token-abc at /path");
    const res = await handleSync(req(), {
      db,
      garmin: () => garmin,
      sync: vi.fn().mockRejectedValue(boom),
    });
    expect(res.status).toBe(500);
    expect(spy.mock.calls).toEqual([["sync failed: TypeError"]]);
    await handleSync(req(), {
      db,
      garmin: () => garmin,
      sync: vi.fn().mockRejectedValue("secret-token-abc"),
    });
    expect(spy.mock.calls[1]).toEqual(["sync failed: UnknownError"]);
    spy.mockRestore();
  });

  it("hides unexpected error details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sync = vi.fn().mockRejectedValue(new Error("secret-token-abc at /path"));
    const res = await handleSync(req(), { db, garmin: () => garmin, sync });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret-token-abc");
    expect(text).not.toContain("/path");
  });

  it("rejects cross-origin and non-POST before doing any work", async () => {
    const sync = vi.fn();
    const g = vi.fn();
    const deps = { db, garmin: g, sync };
    expect((await handleSync(req({ origin: "http://evil.example" }), deps)).status).toBe(403);
    expect((await handleSync(req({}, "GET"), deps)).status).toBe(405);
    expect(g).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
});

describe("handleFitDownload", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = createTestDb();
    const base = { startTime: new Date(0), lastSyncedAt: new Date(0) };
    await t.db.activity.create({
      data: { garminActivityId: "1001", fitFile: new Uint8Array([1, 2, 3]), ...base },
    });
    await t.db.activity.create({ data: { garminActivityId: "1002", ...base } });
  });
  afterEach(() => t.cleanup());

  it("streams the stored FIT with download headers", async () => {
    const res = await handleFitDownload(req({}, "GET"), "1001", t.db);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="1001.fit"');
    expect(res.headers.get("content-length")).toBe("3");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it.each(["1002", "9999", "abc", '1001"; x=', "../1001", ""])("404 for %j", async (id) => {
    expect((await handleFitDownload(req({}, "GET"), id, t.db)).status).toBe(404);
  });
});

describe("handleSync default sync service", () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => t.cleanup());

  it("runs the real sync against an injected fake client when no sync override is given", async () => {
    const fake = {
      listActivities: vi.fn().mockResolvedValue([]),
      downloadActivityFit: vi.fn(),
    } as unknown as GarminClient;
    const res = await handleSync(req(), { db: () => t.db, garmin: () => fake });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "succeeded", imported: 0, failed: 0 });
    expect(fake.listActivities).toHaveBeenCalled();
  });
});
