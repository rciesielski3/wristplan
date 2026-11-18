import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import {
  type GarminActivity,
  GarminAuthError,
  type GarminClient,
  GarminNetworkError,
  GarminRateLimitError,
  GarminResponseError,
  GarminServerError,
} from "../garmin";
import { SyncInProgressError, syncActivities } from "./index";

const T0 = new Date("2026-05-01T12:00:00.000Z");
const FIT = new Uint8Array([1, 2, 3, 4]);

const act = (id: number, over: Partial<GarminActivity> = {}): GarminActivity => ({
  garminActivityId: String(id),
  name: `Run ${id}`,
  sport: "running",
  startTime: new Date("2026-03-01T06:30:00.000Z"),
  durationSeconds: 1800,
  distanceMeters: 5000,
  ...over,
});

const apiErr = {
  auth: () => new GarminAuthError(401, "GET", "/p", "denied"),
  server: () => new GarminServerError(503, "GET", "/p", ""),
  rate: (s: number | undefined) => new GarminRateLimitError("GET", "/p", "", s),
};

type ListFn = GarminClient["listActivities"];
type DownloadFn = GarminClient["downloadActivityFit"];

describe("syncActivities", () => {
  let t: TestDb;
  let list: ReturnType<typeof vi.fn<ListFn>>;
  let download: ReturnType<typeof vi.fn<DownloadFn>>;
  let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;

  const run = (extra: { pageSize?: number; now?: () => Date } = {}) =>
    syncActivities({
      garmin: { listActivities: list, downloadActivityFit: download },
      db: t.db,
      now: () => T0,
      sleep,
      ...extra,
    });

  beforeEach(() => {
    t = createTestDb();
    list = vi.fn<ListFn>().mockResolvedValue([]);
    download = vi.fn<DownloadFn>().mockResolvedValue(FIT);
    sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  });
  afterEach(() => t.cleanup());

  it("imports activities with FIT and records the run", async () => {
    list.mockResolvedValueOnce([act(1), act(2)]);
    const r = await run();
    expect(r).toMatchObject({ status: "succeeded", imported: 2, updated: 0, failed: 0 });
    const rows = await t.db.activity.findMany({ orderBy: { garminActivityId: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "Run 1",
      syncStatus: "synced",
      createdAt: T0,
      lastSyncedAt: T0,
    });
    expect(Array.from(rows[0]?.fitFile ?? [])).toEqual([1, 2, 3, 4]);
    expect(rows[0]?.fitDownloadedAt).toEqual(T0);
    const stored = await t.db.syncRun.findUniqueOrThrow({ where: { id: r.runId } });
    expect(stored).toMatchObject({
      status: "succeeded",
      imported: 2,
      finishedAt: T0,
      errorMessage: null,
    });
  });

  it("passes the date range and paging params to garmin", async () => {
    await syncActivities({
      garmin: { listActivities: list, downloadActivityFit: download },
      db: t.db,
      sleep,
      startDate: "2026-01-01",
      endDate: "2026-02-01",
    });
    expect(list).toHaveBeenCalledWith({
      start: 0,
      limit: 100,
      sortOrder: "asc",
      startDate: "2026-01-01",
      endDate: "2026-02-01",
    });
  });

  it("re-running creates no duplicates, refreshes API fields and keeps the FIT", async () => {
    list.mockResolvedValueOnce([act(1)]);
    await run();
    const first = await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "1" } });
    const later = new Date("2026-05-02T00:00:00.000Z");
    list.mockResolvedValueOnce([act(1, { name: "Renamed", distanceMeters: 6000 })]);
    const r = await run({ now: () => later });
    expect(r).toMatchObject({ imported: 0, updated: 1, failed: 0 });
    const rows = await t.db.activity.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id,
      name: "Renamed",
      distanceMeters: 6000,
      createdAt: T0,
      lastSyncedAt: later,
      fitDownloadedAt: T0,
    });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("isolates a FIT failure, then recovers on the next run", async () => {
    list.mockResolvedValueOnce([act(1), act(2)]);
    download.mockRejectedValueOnce(new GarminResponseError("GET", "/p", "bad zip"));
    const r = await run();
    expect(r).toMatchObject({ status: "succeeded", imported: 2, failed: 1 });
    const bad = await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "1" } });
    expect(bad).toMatchObject({ syncStatus: "failed", fitFile: null });
    const good = await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "2" } });
    expect(good.syncStatus).toBe("synced");

    list.mockResolvedValueOnce([act(1), act(2)]);
    const r2 = await run();
    expect(r2).toMatchObject({ updated: 2, failed: 0 });
    expect(download).toHaveBeenCalledTimes(3);
    const fixed = await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "1" } });
    expect(fixed).toMatchObject({ syncStatus: "synced" });
    expect(fixed.fitFile).not.toBeNull();
  });

  it("aborts on auth error with a redacted failed run, keeping earlier work", async () => {
    list.mockResolvedValueOnce([act(1), act(2)]);
    download.mockResolvedValueOnce(FIT).mockRejectedValueOnce(apiErr.auth());
    const r = await run();
    expect(r).toMatchObject({
      status: "failed",
      imported: 1,
      errorMessage: "GarminAuthError (401)",
    });
    expect(await t.db.activity.count()).toBe(1);
    const stored = await t.db.syncRun.findUniqueOrThrow({ where: { id: r.runId } });
    expect(stored).toMatchObject({ status: "failed", finishedAt: T0 });
    expect(stored.errorMessage).toBe("GarminAuthError (401)");
  });

  it("honours a short retry-after once, then continues", async () => {
    list.mockRejectedValueOnce(apiErr.rate(5)).mockResolvedValueOnce([act(1)]);
    const r = await run();
    expect(r.status).toBe("succeeded");
    expect(sleep).toHaveBeenCalledExactlyOnceWith(5000);
  });

  it("sleeps for a rate limit once per page, then aborts on the next", async () => {
    list.mockRejectedValueOnce(apiErr.rate(1)).mockResolvedValueOnce([act(1)]);
    download.mockRejectedValueOnce(apiErr.rate(1));
    const r = await run();
    expect(r).toMatchObject({ status: "failed", errorMessage: "GarminRateLimitError (429)" });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it.each([[undefined], [61]])("aborts on rate limit with retry-after %s", async (s) => {
    list.mockRejectedValueOnce(apiErr.rate(s));
    const r = await run();
    expect(r).toMatchObject({ status: "failed", errorMessage: "GarminRateLimitError (429)" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries 5xx and network errors with exponential backoff, then succeeds", async () => {
    list
      .mockRejectedValueOnce(apiErr.server())
      .mockRejectedValueOnce(new GarminNetworkError("GET", "/p", true))
      .mockResolvedValueOnce([]);
    const r = await run();
    expect(r.status).toBe("succeeded");
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it("fails the run after two retries on persistent 5xx", async () => {
    list.mockRejectedValue(apiErr.server());
    const r = await run();
    expect(r).toMatchObject({ status: "failed", errorMessage: "GarminServerError (503)" });
    expect(list).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it("redacts network and unknown errors to the class name", async () => {
    list.mockRejectedValueOnce(new GarminNetworkError("GET", "/p", false));
    list.mockRejectedValue(new GarminNetworkError("GET", "/p", false));
    expect((await run()).errorMessage).toBe("GarminNetworkError");
    list.mockReset().mockRejectedValue(new Error("token=abc123 secret body"));
    const r = await run();
    expect(r.errorMessage).toBe("Error");
    list.mockReset().mockRejectedValue("boom");
    expect((await run()).errorMessage).toBe("UnknownError");
    const rows = await t.db.syncRun.findMany();
    expect(JSON.stringify(rows)).not.toMatch(/abc123|secret|\/p/);
  });

  it("marks a stale running run failed and proceeds", async () => {
    const stale = await t.db.syncRun.create({
      data: { startedAt: new Date(T0.getTime() - 31 * 60 * 1000), status: "running" },
    });
    const r = await run();
    expect(r.status).toBe("succeeded");
    const old = await t.db.syncRun.findUniqueOrThrow({ where: { id: stale.id } });
    expect(old).toMatchObject({
      status: "failed",
      finishedAt: T0,
      errorMessage: "interrupted (stale run)",
    });
  });

  it("rejects a concurrent run and leaves the active one untouched", async () => {
    const active = await t.db.syncRun.create({
      data: { startedAt: new Date(T0.getTime() - 60 * 1000), status: "running" },
    });
    await expect(run()).rejects.toBeInstanceOf(SyncInProgressError);
    expect(list).not.toHaveBeenCalled();
    expect(await t.db.syncRun.count()).toBe(1);
    expect((await t.db.syncRun.findUniqueOrThrow({ where: { id: active.id } })).status).toBe(
      "running",
    );
  });

  describe("pagination", () => {
    it("stops on a short page", async () => {
      list.mockResolvedValueOnce([act(1), act(2)]).mockResolvedValueOnce([act(3)]);
      const r = await run({ pageSize: 2 });
      expect(r.imported).toBe(3);
      expect(list.mock.calls.map(([i]) => i?.start)).toEqual([0, 2]);
    });

    it("requests one more page after an exact-size page and stops on empty", async () => {
      list.mockResolvedValueOnce([act(1), act(2)]).mockResolvedValueOnce([]);
      const r = await run({ pageSize: 2 });
      expect(r.imported).toBe(2);
      expect(list).toHaveBeenCalledTimes(2);
    });

    it("handles an empty first page", async () => {
      const r = await run({ pageSize: 2 });
      expect(r).toMatchObject({ status: "succeeded", imported: 0 });
      expect(list).toHaveBeenCalledTimes(1);
    });
  });

  it("uses real clock and timers by default", async () => {
    vi.useFakeTimers();
    try {
      list.mockRejectedValueOnce(apiErr.server()).mockResolvedValueOnce([]);
      const p = syncActivities({
        garmin: { listActivities: list, downloadActivityFit: download },
        db: t.db,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect((await p).status).toBe("succeeded");
    } finally {
      vi.useRealTimers();
    }
  });
});
