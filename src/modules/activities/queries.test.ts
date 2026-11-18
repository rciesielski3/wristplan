import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import {
  ACTIVITY_LIST_LIMIT,
  formatDistance,
  formatDuration,
  formatText,
  formatTimestamp,
  latestSyncRun,
  listActivities,
} from "./index";

describe("queries", () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => t.cleanup());

  it("handles an empty database", async () => {
    expect(await listActivities(t.db)).toEqual([]);
    expect(await latestSyncRun(t.db)).toBeNull();
  });

  it("lists newest first without the FIT blob", async () => {
    const lastSyncedAt = new Date(0);
    await t.db.activity.create({
      data: {
        garminActivityId: "1",
        startTime: new Date(1000),
        lastSyncedAt,
        fitFile: new Uint8Array([1]),
      },
    });
    await t.db.activity.create({
      data: { garminActivityId: "2", startTime: new Date(2000), lastSyncedAt },
    });
    const rows = await listActivities(t.db);
    expect(rows.map((r) => r.garminActivityId)).toEqual(["2", "1"]);
    expect(rows[0]).not.toHaveProperty("fitFile");
  });

  it("returns the latest run", async () => {
    await t.db.syncRun.create({ data: { startedAt: new Date(1000), status: "failed" } });
    await t.db.syncRun.create({ data: { startedAt: new Date(2000), status: "succeeded" } });
    expect((await latestSyncRun(t.db))?.status).toBe("succeeded");
  });
});

describe("format", () => {
  it("shows a dash for null", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDistance(null)).toBe("—");
    expect(formatText(null)).toBe("—");
    expect(formatText("")).toBe("—");
    expect(formatTimestamp(null)).toBe("—");
  });

  it("formats values", () => {
    expect(formatDuration(1800.4)).toBe("30:00");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDistance(5000.25)).toBe("5.00 km");
    expect(formatText("Run")).toBe("Run");
    expect(formatTimestamp(new Date("2026-03-01T06:30:00Z"))).toBe("2026-03-01 06:30 UTC");
  });
});

describe("list bounds", () => {
  it("caps the list at the activity limit, newest first", async () => {
    const t = createTestDb();
    try {
      const lastSyncedAt = new Date(0);
      await t.db.activity.createMany({
        data: Array.from({ length: ACTIVITY_LIST_LIMIT + 3 }, (_, i) => ({
          garminActivityId: String(i),
          startTime: new Date(i * 1000),
          lastSyncedAt,
        })),
      });
      const rows = await listActivities(t.db);
      expect(rows).toHaveLength(ACTIVITY_LIST_LIMIT);
      expect(rows[0]?.garminActivityId).toBe(String(ACTIVITY_LIST_LIMIT + 2));
    } finally {
      await t.cleanup();
    }
  });
});

describe("format edge cases", () => {
  it.each([
    [0, "0:00"],
    [59.4, "0:59"],
    [59.5, "1:00"],
    [3599.6, "1:00:00"],
    [3600, "1:00:00"],
    [86_399, "23:59:59"],
    [360_000, "100:00:00"],
  ])("formats duration %d as %s", (s, out) => {
    expect(formatDuration(s)).toBe(out);
  });

  it("does not turn zero into a dash and rounds distance to two decimals", () => {
    expect(formatDistance(0)).toBe("0.00 km");
    expect(formatDistance(1005)).toBe("1.00 km");
    expect(formatDistance(42_195)).toBe("42.20 km");
  });

  it("renders timestamps in UTC regardless of host timezone", () => {
    expect(formatTimestamp(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31 23:59 UTC");
  });

  it("keeps markup in text verbatim for React to escape", () => {
    expect(formatText("<img onerror=x>")).toBe("<img onerror=x>");
  });
});
