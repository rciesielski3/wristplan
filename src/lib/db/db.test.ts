import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import { type Db, getDb } from "./index";

const startTime = new Date("2026-01-02T03:04:05.000Z");
const data = (name: string) => ({
  garminActivityId: "act-1",
  name,
  sport: "running",
  startTime,
  durationSeconds: 1800.5,
  distanceMeters: 5000,
  lastSyncedAt: startTime,
});

describe("db", () => {
  let t: TestDb;
  let db: Db;

  beforeEach(() => {
    t = createTestDb();
    db = t.db;
  });

  afterEach(async () => {
    await t.cleanup();
    vi.unstubAllEnvs();
  });

  it("stores an activity with defaults", async () => {
    const row = await db.activity.create({ data: data("Morning run") });
    expect(row.syncStatus).toBe("synced");
    expect(row.id).toBeTruthy();
    expect(row.startTime).toEqual(startTime);
  });

  it("upserting the same garminActivityId twice yields one row", async () => {
    const upsert = (name: string) =>
      db.activity.upsert({
        where: { garminActivityId: "act-1" },
        create: data(name),
        update: { name },
      });
    await upsert("first");
    await upsert("second");
    const rows = await db.activity.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("second");
  });

  it("getDb builds one cached client from DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", `file:${join(t.dir, "cached.db")}`);
    const first = getDb();
    expect(getDb()).toBe(first);
    await first.$disconnect();
  });
});
