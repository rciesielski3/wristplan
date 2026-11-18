import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { createDb } from "../../lib/db/index";
import {
  type GarminActivity,
  GarminAuthError,
  type GarminClient,
  GarminRateLimitError,
  GarminResponseError,
  GarminServerError,
} from "../garmin";
import { SyncInProgressError, syncActivities } from "./index";

const T0 = new Date("2026-05-01T12:00:00.000Z");
const MIN = 60 * 1000;
const STALE = 30 * MIN;

const act = (id: number): GarminActivity => ({
  garminActivityId: String(id),
  name: `Run ${id}`,
  sport: "running",
  startTime: new Date("2026-03-01T06:30:00.000Z"),
  durationSeconds: 1800,
  distanceMeters: 5000,
});

type ListFn = GarminClient["listActivities"];
type DownloadFn = GarminClient["downloadActivityFit"];

describe("syncActivities (adversarial)", () => {
  let t: TestDb;
  let list: ReturnType<typeof vi.fn<ListFn>>;
  let download: ReturnType<typeof vi.fn<DownloadFn>>;
  let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;

  const run = (extra: { pageSize?: number; now?: () => Date; db?: TestDb["db"] } = {}) =>
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
    download = vi.fn<DownloadFn>().mockResolvedValue(new Uint8Array([9]));
    sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  });
  afterEach(() => t.cleanup());

  describe("concurrency guard", () => {
    it("lets only one of two parallel syncs on one connection run", async () => {
      list.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return [];
      });
      const res = await Promise.allSettled([run(), run()]);
      expect(res.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = res.find((r) => r.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
        SyncInProgressError,
      );
      expect(list).toHaveBeenCalledTimes(1);
      expect(await t.db.syncRun.count()).toBe(1);
    });

    it("rejects a second sync on another connection while the first is in flight", async () => {
      const db2 = createDb(`file:${t.dir}/test.db`);
      try {
        let release: (v: GarminActivity[]) => void = () => undefined;
        list.mockImplementationOnce(() => new Promise<GarminActivity[]>((r) => (release = r)));
        const first = run();
        await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
        await expect(run({ db: db2 })).rejects.toBeInstanceOf(SyncInProgressError);
        expect(list).toHaveBeenCalledTimes(1);
        release([]);
        expect((await first).status).toBe("succeeded");
        // the lock is released: a later sync on the other connection may run
        expect((await run({ db: db2 })).status).toBe("succeeded");
      } finally {
        await db2.$disconnect();
      }
    });

    it("takes the sqlite write lock on the guard's first statement (no read-then-write race)", async () => {
      // Mirrors the first statement of the guard transaction on two raw connections.
      const file = `${t.dir}/test.db`;
      const a = new DatabaseSync(file);
      const b = new DatabaseSync(file);
      try {
        const sql = "UPDATE SyncRun SET status = 'failed' WHERE status = 'running' AND 0";
        a.exec("BEGIN");
        a.exec(sql);
        b.exec("BEGIN");
        expect(() => b.exec(sql)).toThrow(/locked|busy/i);
        a.exec("ROLLBACK");
        b.exec("ROLLBACK");
      } finally {
        a.close();
        b.close();
      }
    });
  });

  describe("stale run recovery", () => {
    const seed = (ageMs: number) =>
      t.db.syncRun.create({
        data: { startedAt: new Date(T0.getTime() - ageMs), status: "running" },
      });

    it("does not recover a run exactly 30 minutes old", async () => {
      await seed(STALE);
      await expect(run()).rejects.toBeInstanceOf(SyncInProgressError);
    });

    it("recovers a run 30 minutes and 1 ms old", async () => {
      await seed(STALE + 1);
      expect((await run()).status).toBe("succeeded");
    });

    it("treats a run started in the future (clock went backwards) as active", async () => {
      await seed(-5 * MIN);
      await expect(run()).rejects.toBeInstanceOf(SyncInProgressError);
      expect(list).not.toHaveBeenCalled();
    });

    it("leaves finished runs alone and does not touch their counts", async () => {
      const done = await t.db.syncRun.create({
        data: { startedAt: new Date(0), status: "succeeded", imported: 7, finishedAt: new Date(1) },
      });
      await run();
      expect(await t.db.syncRun.findUniqueOrThrow({ where: { id: done.id } })).toMatchObject({
        status: "succeeded",
        imported: 7,
        errorMessage: null,
      });
    });

    it("leaves a run in running when the final update fails, and recovers it after 30 minutes", async () => {
      await t.db.$executeRawUnsafe(
        "CREATE TRIGGER no_finish BEFORE UPDATE ON SyncRun WHEN NEW.status != 'failed' OR NEW.errorMessage IS NULL OR NEW.errorMessage != 'interrupted (stale run)' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
      );
      await expect(run()).rejects.toThrow();
      const [stuck] = await t.db.syncRun.findMany();
      expect(stuck?.status).toBe("running");
      await expect(run({ now: () => new Date(T0.getTime() + STALE) })).rejects.toBeInstanceOf(
        SyncInProgressError,
      );
      await t.db.$executeRawUnsafe("DROP TRIGGER no_finish");
      const r = await run({ now: () => new Date(T0.getTime() + STALE + 1) });
      expect(r.status).toBe("succeeded");
      expect(
        (await t.db.syncRun.findUniqueOrThrow({ where: { id: stuck?.id ?? "" } })).status,
      ).toBe("failed");
    });
  });

  describe("pagination", () => {
    it("stops when the API ignores `start` and keeps returning the same full page", async () => {
      list.mockResolvedValue([act(1), act(2)]);
      const r = await run({ pageSize: 2 });
      expect(r).toMatchObject({ status: "succeeded", imported: 2, updated: 0 });
      expect(list).toHaveBeenCalledTimes(2);
    });

    it("syncs a duplicate within a page once and counts it once", async () => {
      list.mockResolvedValueOnce([act(1), act(1), act(2)]);
      const r = await run({ pageSize: 5 });
      expect(r).toMatchObject({ imported: 2, updated: 0, failed: 0 });
      expect(download).toHaveBeenCalledTimes(2);
    });

    it("ignores rows repeated across pages but keeps paging while new rows appear", async () => {
      list
        .mockResolvedValueOnce([act(1), act(2)])
        .mockResolvedValueOnce([act(2), act(3)])
        .mockResolvedValueOnce([]);
      const r = await run({ pageSize: 2 });
      expect(r).toMatchObject({ imported: 3, updated: 0 });
      expect(list.mock.calls.map(([i]) => i?.start)).toEqual([0, 2, 4]);
    });

    it("processes every row when Garmin returns more than the limit", async () => {
      list.mockResolvedValueOnce([act(1), act(2), act(3)]).mockResolvedValueOnce([]);
      const r = await run({ pageSize: 2 });
      expect(r.imported).toBe(3);
      expect(await t.db.activity.count()).toBe(3);
    });

    it("advances start by the page size across an exact multiple", async () => {
      list
        .mockResolvedValueOnce([act(1), act(2)])
        .mockResolvedValueOnce([act(3), act(4)])
        .mockResolvedValueOnce([]);
      await run({ pageSize: 2 });
      expect(list.mock.calls.map(([i]) => i?.start)).toEqual([0, 2, 4]);
    });
  });

  describe("data safety", () => {
    it("never overwrites a stored FIT or its timestamp on re-sync", async () => {
      list.mockResolvedValue([act(1)]);
      download.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
      await run();
      download.mockResolvedValue(new Uint8Array([7, 7, 7]));
      await run({ now: () => new Date(T0.getTime() + 1000) });
      const row = await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "1" } });
      expect(Array.from(row.fitFile ?? [])).toEqual([1, 2, 3]);
      expect(row.fitDownloadedAt).toEqual(T0);
      expect(download).toHaveBeenCalledTimes(1);
    });

    it("keeps a good row synced with its FIT when later syncs would fail to download", async () => {
      list.mockResolvedValue([act(1)]);
      await run();
      download.mockRejectedValue(new GarminResponseError("GET", "/p", "bad"));
      const r = await run({ now: () => new Date(T0.getTime() + 1000) });
      expect(r).toMatchObject({ failed: 0, updated: 1 });
      const row = await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "1" } });
      expect(row).toMatchObject({ syncStatus: "synced" });
      expect(row.fitFile).not.toBeNull();
    });

    it("leaves a row without FIT untouched by FIT state when download hits a fatal error", async () => {
      list.mockResolvedValue([act(1)]);
      download.mockRejectedValueOnce(new GarminResponseError("GET", "/p", "bad"));
      await run();
      download.mockRejectedValueOnce(new GarminAuthError(401, "GET", "/p", "x"));
      const r = await run({ now: () => new Date(T0.getTime() + 1000) });
      expect(r.status).toBe("failed");
      const row = await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "1" } });
      expect(row).toMatchObject({ syncStatus: "failed", fitFile: null, fitDownloadedAt: null });
      expect(row.lastSyncedAt).toEqual(T0);
    });

    it("does not change createdAt or id on update and bumps lastSyncedAt", async () => {
      list.mockResolvedValue([act(1)]);
      await run();
      const before = await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "1" } });
      const later = new Date(T0.getTime() + 5000);
      await run({ now: () => later });
      const after = await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "1" } });
      expect(after.createdAt).toEqual(before.createdAt);
      expect(after.id).toBe(before.id);
      expect(after.lastSyncedAt).toEqual(later);
    });

    it("overwrites API-owned fields but nothing else on update", async () => {
      list.mockResolvedValue([act(1)]);
      await run();
      const before = await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "1" } });
      list.mockResolvedValue([{ ...act(1), name: "New", durationSeconds: 1, distanceMeters: 2 }]);
      await run({ now: () => new Date(T0.getTime() + 1) });
      const after = await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "1" } });
      expect(after).toMatchObject({ name: "New", durationSeconds: 1, distanceMeters: 2 });
      expect(after.fitFile).toEqual(before.fitFile);
    });
  });

  describe("error recording", () => {
    it("records a database error without SQL or values and keeps earlier counts", async () => {
      await t.db.$executeRawUnsafe(
        "CREATE TRIGGER boom BEFORE INSERT ON Activity WHEN NEW.garminActivityId = '2' BEGIN SELECT RAISE(ABORT, 'secret-value-xyz'); END",
      );
      list.mockResolvedValueOnce([act(1), act(2), act(3)]);
      const r = await run();
      expect(r).toMatchObject({ status: "failed", imported: 1, updated: 0 });
      expect(r.errorMessage).not.toMatch(/secret|INSERT|Activity|invocation/i);
      const stored = await t.db.syncRun.findUniqueOrThrow({ where: { id: r.runId } });
      expect(stored).toMatchObject({ status: "failed", imported: 1, errorMessage: r.errorMessage });
      expect(stored.finishedAt).toEqual(T0);
    });

    it("never stores a response body from an API error", async () => {
      list.mockRejectedValue(new GarminServerError(503, "GET", "/path?token=abc", "body-with-pii"));
      const r = await run();
      expect(r.errorMessage).toBe("GarminServerError (503)");
      const rows = await t.db.syncRun.findMany();
      expect(JSON.stringify(rows)).not.toMatch(/pii|token|abc|path/);
    });
  });

  describe("backoff and rate limits", () => {
    const rate = (s: number) => new GarminRateLimitError("GET", "/p", "", s);

    it("honours a retry-after of exactly 60 seconds", async () => {
      list.mockRejectedValueOnce(rate(60)).mockResolvedValueOnce([]);
      expect((await run()).status).toBe("succeeded");
      expect(sleep).toHaveBeenCalledExactlyOnceWith(60_000);
    });

    it("sleeps once per page for rate limits across pages", async () => {
      list
        .mockRejectedValueOnce(rate(1))
        .mockResolvedValueOnce([act(1), act(2)])
        .mockRejectedValueOnce(rate(2))
        .mockResolvedValueOnce([]);
      const r = await run({ pageSize: 2 });
      expect(r.status).toBe("succeeded");
      expect(sleep.mock.calls).toEqual([[1000], [2000]]);
    });

    it("retries a persistent FIT download 5xx exactly twice then fails the run", async () => {
      list.mockResolvedValueOnce([act(1)]);
      download.mockRejectedValue(new GarminServerError(500, "GET", "/p", ""));
      const r = await run();
      expect(r).toMatchObject({ status: "failed", errorMessage: "GarminServerError (500)" });
      expect(download).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[1000], [2000]]);
      expect(await t.db.activity.count()).toBe(0);
    });
  });

  describe("FIT blob handling", () => {
    const stored = async () =>
      (await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "1" } })).fitFile;

    it("round-trips a Buffer byte-exact", async () => {
      list.mockResolvedValueOnce([act(1)]);
      const bytes = Buffer.from([0, 255, 128, 1, 0]);
      download.mockResolvedValueOnce(bytes);
      await run();
      expect(Buffer.from((await stored()) ?? []).equals(bytes)).toBe(true);
    });

    it("stores a zero-length FIT as an empty blob and does not re-download it", async () => {
      list.mockResolvedValue([act(1)]);
      download.mockResolvedValueOnce(new Uint8Array(0));
      await run();
      const row = await t.db.activity.findUniqueOrThrow({ where: { garminActivityId: "1" } });
      expect(row.fitFile?.byteLength).toBe(0);
      expect(row.fitDownloadedAt).toEqual(T0);
      await run();
      expect(download).toHaveBeenCalledTimes(1);
    });

    it("round-trips a 4 MiB FIT byte-exact", async () => {
      list.mockResolvedValueOnce([act(1)]);
      const big = new Uint8Array(4 * 1024 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
      download.mockResolvedValueOnce(big);
      await run();
      const out = await stored();
      expect(out?.byteLength).toBe(big.length);
      expect(Buffer.from(out ?? []).equals(Buffer.from(big))).toBe(true);
    });

    it("does not alias the caller's buffer", async () => {
      list.mockResolvedValueOnce([act(1)]);
      const bytes = new Uint8Array([5, 6]);
      download.mockImplementationOnce(async () => bytes);
      await run();
      expect(Array.from((await stored()) ?? [])).toEqual([5, 6]);
    });
  });
});
