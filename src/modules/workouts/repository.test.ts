import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../test/db-helpers";
import {
  createWorkoutRepository,
  LIMITS,
  WORKOUT_LIST_LIMIT,
  WorkoutCorruptError,
  WorkoutNotFoundError,
  WorkoutNotTemplateError,
  type WorkoutRepository,
  WorkoutValidationError,
} from "./index";

const make = (name = "Easy run") => ({
  name,
  sport: "run",
  steps: [
    { kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 1 } },
    {
      kind: "repeat",
      times: 3,
      steps: [
        { kind: "work", end: { type: "time", seconds: 180 }, target: { type: "hr", zone: 4 } },
        { kind: "recovery", end: { type: "time", seconds: 120 }, target: { type: "hr", zone: 1 } },
      ],
    },
  ],
});

const at = (iso: string) => vi.setSystemTime(new Date(iso));

describe("workout repository", () => {
  let t: TestDb;
  let repo: WorkoutRepository;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("2030-01-01T00:00:00.000Z");
    t = createTestDb();
    repo = createWorkoutRepository(t.db);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.cleanup();
  });

  const insertRaw = (id: string, definition: string) =>
    t.db.workout.create({
      data: { id, definition, isTemplate: false },
    });

  it("round-trips create and get", async () => {
    const created = await repo.create(make());
    expect(created.isTemplate).toBe(false);
    expect(created.workout).toEqual(make());
    expect(await repo.get(created.id)).toEqual(created);
    const row = await t.db.workout.findUniqueOrThrow({ where: { id: created.id } });
    expect(JSON.parse(row.definition)).toEqual(make());
  });

  it("creates templates", async () => {
    const created = await repo.create(make(), { isTemplate: true });
    expect(created.isTemplate).toBe(true);
  });

  it("rejects invalid input without writing", async () => {
    await expect(repo.create({ ...make(), sport: "bike" })).rejects.toBeInstanceOf(
      WorkoutValidationError,
    );
    await expect(repo.create("nope")).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ path: "workout" })]),
    });
    expect(await t.db.workout.count()).toBe(0);
  });

  it("get throws not found for unknown and malformed ids", async () => {
    await expect(repo.get("missing")).rejects.toThrow(new WorkoutNotFoundError("missing"));
    const bad = await repo.get("x'; DROP TABLE Workout;--").catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(WorkoutNotFoundError);
    expect((bad as Error).message).toBe("Workout not found: invalid id");
    await expect(repo.get("")).rejects.toBeInstanceOf(WorkoutNotFoundError);
    await expect(repo.get("a".repeat(65))).rejects.toBeInstanceOf(WorkoutNotFoundError);
  });

  it("updates, refreshes updatedAt and keeps template flag by default", async () => {
    const created = await repo.create(make(), { isTemplate: true });
    at("2030-01-01T00:00:01.000Z");
    const updated = await repo.update(created.id, make("Renamed"));
    expect(updated.workout.name).toBe("Renamed");
    expect(updated.isTemplate).toBe(true);
    expect(updated.createdAt).toEqual(created.createdAt);
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    expect((await repo.get(created.id)).workout.name).toBe("Renamed");
  });

  it("flips isTemplate only when explicit", async () => {
    const created = await repo.create(make());
    const flipped = await repo.update(created.id, make(), { isTemplate: true });
    expect(flipped.isTemplate).toBe(true);
    const back = await repo.update(created.id, make(), { isTemplate: false });
    expect(back.isTemplate).toBe(false);
  });

  it("invalid update leaves the old row untouched", async () => {
    const created = await repo.create(make());
    await expect(repo.update(created.id, { ...make(), steps: [] })).rejects.toBeInstanceOf(
      WorkoutValidationError,
    );
    expect(await repo.get(created.id)).toEqual(created);
  });

  it("update throws not found", async () => {
    await expect(repo.update("missing", make())).rejects.toBeInstanceOf(WorkoutNotFoundError);
    await expect(repo.update("bad id", make())).rejects.toBeInstanceOf(WorkoutNotFoundError);
  });

  it("concurrent updates both succeed and the last write wins whole", async () => {
    const created = await repo.create(make());
    await Promise.all([repo.update(created.id, make("A")), repo.update(created.id, make("B"))]);
    const stored = await repo.get(created.id);
    expect(["A", "B"]).toContain(stored.workout.name);
  });

  it("deletes and then reports not found on repeat", async () => {
    const created = await repo.create(make());
    await repo.delete(created.id);
    expect(await t.db.workout.count()).toBe(0);
    await expect(repo.delete(created.id)).rejects.toBeInstanceOf(WorkoutNotFoundError);
    await expect(repo.delete("bad id")).rejects.toBeInstanceOf(WorkoutNotFoundError);
  });

  it("duplicates independently with a copy name", async () => {
    const original = await repo.create(make());
    const copy = await repo.duplicate(original.id);
    expect(copy.id).not.toBe(original.id);
    expect(copy.workout).toEqual(make("Easy run (copy)"));
    expect(copy.isTemplate).toBe(false);
    await repo.update(copy.id, make("Changed"));
    expect(await repo.get(original.id)).toEqual(original);
  });

  it("duplicate honours name and asTemplate", async () => {
    const original = await repo.create(make());
    const copy = await repo.duplicate(original.id, { name: "Mine", asTemplate: true });
    expect(copy).toMatchObject({ isTemplate: true, workout: { name: "Mine" } });
    await expect(repo.duplicate(original.id, { name: " " })).rejects.toBeInstanceOf(
      WorkoutValidationError,
    );
    await expect(repo.duplicate("missing")).rejects.toBeInstanceOf(WorkoutNotFoundError);
  });

  it("truncates long copy names to the limit", async () => {
    const full = await repo.create(make("x".repeat(LIMITS.nameMaxLength)));
    const copy = await repo.duplicate(full.id);
    expect(copy.workout.name).toBe(`${"x".repeat(LIMITS.nameMaxLength - 7)} (copy)`);
    expect(copy.workout.name).toHaveLength(LIMITS.nameMaxLength);
  });

  it("does not split surrogate pairs or leave a space before the suffix", async () => {
    const emoji = await repo.create(make(`${"a".repeat(92)}😀😀`));
    const c1 = await repo.duplicate(emoji.id);
    expect(c1.workout.name).toBe(`${"a".repeat(92)} (copy)`);
    const spaced = await repo.create(make(`${"a".repeat(92)}   ${"b".repeat(5)}`));
    const c2 = await repo.duplicate(spaced.id);
    expect(c2.workout.name).toBe(`${"a".repeat(92)} (copy)`);
  });

  it("creates a non-template copy from a template", async () => {
    const tpl = await repo.create(make("Tempo"), { isTemplate: true });
    const w = await repo.createFromTemplate(tpl.id);
    expect(w).toMatchObject({ isTemplate: false, workout: { name: "Tempo" } });
    expect(w.id).not.toBe(tpl.id);
    const named = await repo.createFromTemplate(tpl.id, { name: "Tuesday" });
    expect(named.workout.name).toBe("Tuesday");
    expect((await repo.get(tpl.id)).isTemplate).toBe(true);
  });

  it("createFromTemplate rejects non-templates and missing ids", async () => {
    const plain = await repo.create(make());
    await expect(repo.createFromTemplate(plain.id)).rejects.toBeInstanceOf(WorkoutNotTemplateError);
    await expect(repo.createFromTemplate("missing")).rejects.toBeInstanceOf(WorkoutNotFoundError);
  });

  it("saves a workout as a template via duplicate", async () => {
    const w = await repo.create(make("Long"));
    const tpl = await repo.duplicate(w.id, { name: "Long", asTemplate: true });
    expect((await repo.list({ templates: true })).items.map((i) => i.id)).toEqual([tpl.id]);
    expect((await repo.list({ templates: false })).items.map((i) => i.id)).toEqual([w.id]);
    expect((await repo.list()).items).toHaveLength(2);
  });

  it("lists newest-updated first", async () => {
    const a = await repo.create(make("A"));
    at("2030-01-01T00:00:01.000Z");
    const b = await repo.create(make("B"));
    at("2030-01-01T00:00:02.000Z");
    await repo.update(a.id, make("A2"));
    expect((await repo.list()).items.map((i) => i.id)).toEqual([a.id, b.id]);
  });

  it("bounds list size", async () => {
    for (let i = 0; i < 3; i++) await repo.create(make(`W${i}`));
    expect((await repo.list({ limit: 2 })).items).toHaveLength(2);
    expect((await repo.list({ limit: 0 })).items).toHaveLength(1);
    expect((await repo.list({ limit: -5 })).items).toHaveLength(1);
    expect((await repo.list({ limit: 1_000_000 })).items).toHaveLength(3);
    expect(WORKOUT_LIST_LIMIT).toBe(200);
  });

  it("get and duplicate throw WorkoutCorruptError for bad stored definitions", async () => {
    await insertRaw("garbage", "{not json");
    await insertRaw("shape", JSON.stringify({ name: "x", sport: "run", steps: [] }));
    for (const id of ["garbage", "shape"]) {
      const err = await repo.get(id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkoutCorruptError);
      expect((err as Error).message).toBe(`Stored workout is corrupt: ${id}`);
      await expect(repo.duplicate(id)).rejects.toBeInstanceOf(WorkoutCorruptError);
    }
  });

  it("list skips corrupt rows and reports their ids", async () => {
    const good = await repo.create(make());
    await insertRaw("garbage", "{not json");
    await insertRaw("shape", JSON.stringify({ name: "x" }));
    const { items, corruptIds } = await repo.list();
    expect(items.map((i) => i.id)).toEqual([good.id]);
    expect([...corruptIds].sort()).toEqual(["garbage", "shape"]);
  });

  it("list rethrows unexpected errors", async () => {
    await t.db.$disconnect();
    const broken = createWorkoutRepository({
      workout: { findMany: () => Promise.reject(new Error("boom")) },
    } as never);
    await expect(broken.list()).rejects.toThrow("boom");
  });

  it("update and delete rethrow non-not-found database errors", async () => {
    const failing = (code?: string) =>
      createWorkoutRepository({
        workout: {
          update: () => Promise.reject(Object.assign(new Error("db"), code ? { code } : {})),
          delete: () => Promise.reject(Object.assign(new Error("db"), code ? { code } : {})),
        },
      } as never);
    await expect(failing("P2002").update("abc", make())).rejects.toThrow("db");
    await expect(failing().delete("abc")).rejects.toThrow("db");
    await expect(failing("P2025").delete("abc")).rejects.toBeInstanceOf(WorkoutNotFoundError);
  });

  it("never lets a non-string id reach the database", async () => {
    const ids = [123, ["abc"], { contains: "a" }, null, undefined, `abc\n`, "a'b", "é"];
    for (const id of ids) {
      for (const call of [
        () => repo.get(id as never),
        () => repo.update(id as never, make()),
        () => repo.delete(id as never),
        () => repo.duplicate(id as never),
        () => repo.createFromTemplate(id as never),
      ]) {
        const err = await call().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WorkoutNotFoundError);
        expect((err as Error).message).toBe("Workout not found: invalid id");
      }
    }
  });

  it("accepts ids of exactly 64 characters and rejects 65", async () => {
    const id = `${"A_-".repeat(21)}z`;
    expect(id).toHaveLength(64);
    await insertRaw(id, JSON.stringify(make()));
    expect((await repo.get(id)).id).toBe(id);
    await expect(repo.get(`${id}z`)).rejects.toThrow("invalid id");
  });

  it("ids are case sensitive", async () => {
    const c = await repo.create(make());
    await expect(repo.get(c.id.toUpperCase())).rejects.toBeInstanceOf(WorkoutNotFoundError);
  });

  it("falls back to the default limit for NaN and clamps infinities and fractions", async () => {
    for (let i = 0; i < 3; i++) await repo.create(make(`W${i}`));
    expect((await repo.list({ limit: Number.NaN })).items).toHaveLength(3);
    expect((await repo.list({ limit: Number.POSITIVE_INFINITY })).items).toHaveLength(3);
    expect((await repo.list({ limit: Number.NEGATIVE_INFINITY })).items).toHaveLength(1);
    expect((await repo.list({ limit: 1.9 })).items).toHaveLength(1);
    expect((await repo.list({ limit: 2 })).items).toHaveLength(2);
  });

  it("caps list at WORKOUT_LIST_LIMIT rows", async () => {
    await t.db.workout.createMany({
      data: Array.from({ length: WORKOUT_LIST_LIMIT + 5 }, (_, i) => ({
        id: `w${i}`,
        definition: JSON.stringify(make()),
      })),
    });
    expect((await repo.list()).items).toHaveLength(WORKOUT_LIST_LIMIT);
    expect((await repo.list({ limit: 1e9 })).items).toHaveLength(WORKOUT_LIST_LIMIT);
  });

  it("orders rows with equal updatedAt by id descending, stable across calls", async () => {
    const when = new Date("2030-02-01T00:00:00.000Z");
    for (const id of ["b", "c", "a"]) {
      await t.db.workout.create({
        data: { id, definition: JSON.stringify(make()), updatedAt: when },
      });
    }
    const ids = async () => (await repo.list()).items.map((i) => i.id);
    expect(await ids()).toEqual(["c", "b", "a"]);
    expect(await ids()).toEqual(["c", "b", "a"]);
  });

  it("template filter applies before the limit", async () => {
    const tpl = await repo.create(make("T"), { isTemplate: true });
    at("2030-01-01T00:00:01.000Z");
    await repo.create(make("P1"));
    await repo.create(make("P2"));
    expect((await repo.list({ templates: true, limit: 1 })).items.map((i) => i.id)).toEqual([
      tpl.id,
    ]);
  });

  it("round-trips the largest allowed definition", async () => {
    const big = {
      name: "b".repeat(LIMITS.nameMaxLength),
      sport: "run",
      steps: Array.from({ length: LIMITS.maxTopLevelSteps }, () => ({
        kind: "repeat",
        times: LIMITS.maxRepeatTimes,
        steps: Array.from({ length: LIMITS.maxRepeatSteps }, () => ({
          kind: "work",
          end: { type: "distance", meters: LIMITS.maxMeters },
          target: { type: "hr", zone: 5 },
        })),
      })),
    };
    const created = await repo.create(big);
    expect((await repo.get(created.id)).workout).toEqual(big);
  });

  it("rejects prototype-pollution and extra keys without writing", async () => {
    const polluted = JSON.parse(
      `{"__proto__":{"admin":true},"name":"x","sport":"run","steps":${JSON.stringify(make().steps)}}`,
    );
    await expect(repo.create(polluted)).rejects.toBeInstanceOf(WorkoutValidationError);
    await expect(repo.create({ ...make(), extra: 1 })).rejects.toBeInstanceOf(
      WorkoutValidationError,
    );
    expect(await t.db.workout.count()).toBe(0);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("treats stored definitions with extra keys, null bytes, huge or null JSON as corrupt", async () => {
    const cases: Record<string, string> = {
      extra: JSON.stringify({ ...make(), evil: 1 }),
      nul: `\u0000${JSON.stringify(make())}`,
      huge: "x".repeat(2_000_000),
      nullJson: "null",
      empty: "",
    };
    for (const [id, def] of Object.entries(cases)) await insertRaw(id, def);
    const good = await repo.create(make());
    const { items, corruptIds } = await repo.list();
    expect(items.map((i) => i.id)).toEqual([good.id]);
    expect([...corruptIds].sort()).toEqual(Object.keys(cases).sort());
    for (const id of Object.keys(cases)) {
      const err = await repo.get(id).catch((e: unknown) => e);
      expect((err as Error).message).toBe(`Stored workout is corrupt: ${id}`);
    }
  });

  it("list of only corrupt rows returns empty items and bounded corruptIds", async () => {
    for (let i = 0; i < WORKOUT_LIST_LIMIT + 3; i++) await insertRaw(`bad${i}`, "{");
    const { items, corruptIds } = await repo.list();
    expect(items).toEqual([]);
    expect(corruptIds).toHaveLength(WORKOUT_LIST_LIMIT);
  });

  it("failed duplicate and createFromTemplate write nothing", async () => {
    const tpl = await repo.create(make(), { isTemplate: true });
    await insertRaw("bad", "{");
    const before = await t.db.workout.count();
    await expect(repo.duplicate(tpl.id, { name: "" })).rejects.toBeInstanceOf(
      WorkoutValidationError,
    );
    await expect(repo.createFromTemplate(tpl.id, { name: "x".repeat(101) })).rejects.toBeInstanceOf(
      WorkoutValidationError,
    );
    await expect(repo.duplicate("bad")).rejects.toBeInstanceOf(WorkoutCorruptError);
    await expect(repo.createFromTemplate("bad")).rejects.toBeInstanceOf(WorkoutCorruptError);
    expect(await t.db.workout.count()).toBe(before);
  });

  it("duplicating a template with asTemplate yields an independent template", async () => {
    const tpl = await repo.create(make("T"), { isTemplate: true });
    const again = await repo.duplicate(tpl.id, { asTemplate: true });
    expect(again).toMatchObject({ isTemplate: true, workout: { name: "T (copy)" } });
    expect((await repo.duplicate(tpl.id)).isTemplate).toBe(false);
  });

  it("copies a 93 character name whole and a 94 character name truncated", async () => {
    const exact = await repo.create(make("n".repeat(93)));
    expect((await repo.duplicate(exact.id)).workout.name).toBe(`${"n".repeat(93)} (copy)`);
    const over = await repo.create(make("n".repeat(94)));
    expect((await repo.duplicate(over.id)).workout.name).toBe(`${"n".repeat(93)} (copy)`);
  });

  it("keeps a complete emoji that ends exactly at the cut", async () => {
    const e = await repo.create(make(`${"a".repeat(91)}😀${"b".repeat(5)}`));
    expect((await repo.duplicate(e.id)).workout.name).toBe(`${"a".repeat(91)}😀 (copy)`);
  });

  it("copy name of a mostly-blank long name stays valid", async () => {
    const w = await repo.create(make(`${" ".repeat(95)}abcde`));
    const copy = await repo.duplicate(w.id);
    expect(copy.workout.name.trim().length).toBeGreaterThan(0);
    expect(copy.workout.name.length).toBeLessThanOrEqual(LIMITS.nameMaxLength);
  });

  it("create rethrows database errors", async () => {
    const failing = createWorkoutRepository({
      workout: {
        create: () => Promise.reject(Object.assign(new Error("db down"), { code: "P1001" })),
      },
    } as never);
    await expect(failing.create(make())).rejects.toThrow("db down");
  });

  it("list rethrows failures that are not corruption", async () => {
    const row = {
      id: "r1",
      definition: JSON.stringify(make()),
      createdAt: new Date(0),
      updatedAt: new Date(0),
      get isTemplate(): boolean {
        throw new Error("row exploded");
      },
    };
    const odd = createWorkoutRepository({
      workout: { findMany: () => Promise.resolve([row]) },
    } as never);
    await expect(odd.list()).rejects.toThrow("row exploded");
  });
});

describe("workout migration", () => {
  const MIGRATIONS = new URL("../../../prisma/migrations/", import.meta.url);
  const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  it("applies on top of a database that already holds activities and sync runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "wristplan-mig-"));
    const sqlite = new DatabaseSync(join(dir, "m.db"));
    try {
      const before = dirs.filter((d) => !d.endsWith("_workout"));
      expect(before.length).toBe(dirs.length - 1);
      for (const d of before)
        sqlite.exec(readFileSync(new URL(`${d}/migration.sql`, MIGRATIONS), "utf8"));
      sqlite.exec(
        `INSERT INTO "Activity" ("id","garminActivityId","startTime","updatedAt","lastSyncedAt") VALUES ('a1','g1',0,0,0);
         INSERT INTO "SyncRun" ("id","startedAt","status") VALUES ('s1',0,'ok');`,
      );
      sqlite.exec(
        readFileSync(
          new URL(`${dirs.find((d) => d.endsWith("_workout"))}/migration.sql`, MIGRATIONS),
          "utf8",
        ),
      );
      const count = (table: string) =>
        (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
      expect([count("Activity"), count("SyncRun"), count("Workout")]).toEqual([1, 1, 0]);
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
