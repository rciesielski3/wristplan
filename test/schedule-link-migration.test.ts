import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "./db-helpers";

const NEW_MIGRATION = new URL(
  "../prisma/migrations/20261122180000_schedule_activity_link/migration.sql",
  import.meta.url,
);

describe("20261122180000_schedule_activity_link migration", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wristplan-mig-"));
    file = join(dir, "m.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps existing rows and enforces a unique link", () => {
    migrate(file, "20261118140000_workout_schedule");
    const sqlite = new DatabaseSync(file);
    try {
      const insert = sqlite.prepare(
        `INSERT INTO "ScheduledWorkout" (id, workoutId, date, status, externalId, updatedAt)
         VALUES (?, 'w1', ?, 'pending', ?, CURRENT_TIMESTAMP)`,
      );
      sqlite.exec(
        `INSERT INTO "Workout" (id, definition, updatedAt) VALUES ('w1', '{}', CURRENT_TIMESTAMP)`,
      );
      insert.run("s1", "2026-06-16", "wristplan-s1");

      sqlite.exec(readFileSync(NEW_MIGRATION, "utf8"));

      expect(
        sqlite
          .prepare(`SELECT id, status, linkedGarminActivityId, matchSource FROM "ScheduledWorkout"`)
          .all(),
      ).toEqual([{ id: "s1", status: "pending", linkedGarminActivityId: null, matchSource: null }]);

      const link = sqlite.prepare(
        `UPDATE "ScheduledWorkout" SET linkedGarminActivityId = '42' WHERE id = ?`,
      );
      insert.run("s2", "2026-06-17", "wristplan-s2");
      insert.run("s3", "2026-06-18", "wristplan-s3");
      insert.run("s4", "2026-06-19", "wristplan-s4");
      link.run("s2");
      expect(() => link.run("s3")).toThrow(/UNIQUE/);
      // NULLs may repeat: s1 and s4 are both unlinked.
    } finally {
      sqlite.close();
    }
  });
  describe("on a database that already holds data", () => {
    const PREVIOUS = "20261118140000_workout_schedule";
    const tables = ["Activity", "SyncRun", "Workout", "ScheduledWorkout"];
    const T = "2026-06-01T10:00:00.000Z";

    const seed = (sqlite: DatabaseSync) => {
      const fit = new Uint8Array([0, 1, 2, 254, 255, 0, 16, 46, 70, 73, 84]);
      sqlite
        .prepare(
          `INSERT INTO "Activity" (id, garminActivityId, name, sport, startTime, durationSeconds, distanceMeters, syncStatus, createdAt, updatedAt, lastSyncedAt, fitFile, fitDownloadedAt)
           VALUES ('a1', '111', 'Easy run', 'running', ?, 1800.5, 5000, 'synced', ?, ?, ?, ?, ?)`,
        )
        .run(T, T, T, T, fit, T);
      sqlite.exec(
        `INSERT INTO "Activity" (id, garminActivityId, startTime, updatedAt, lastSyncedAt) VALUES ('a2', '222', '${T}', '${T}', '${T}')`,
      );
      sqlite.exec(
        `INSERT INTO "SyncRun" (id, startedAt, finishedAt, status, imported, updated, failed, errorMessage)
         VALUES ('r1', '${T}', '${T}', 'failed', 1, 2, 3, 'boom'), ('r2', '${T}', NULL, 'running', 0, 0, 0, NULL)`,
      );
      sqlite.exec(
        `INSERT INTO "Workout" (id, definition, isTemplate, createdAt, updatedAt) VALUES ('w1', '{"a":"é"}', 1, '${T}', '${T}'), ('w2', '{}', 0, '${T}', '${T}')`,
      );
      const rows: [string, string, string, string | null, string | null][] = [
        ["s1", "2026-06-16", "pending", null, null],
        ["s2", "2026-06-17", "published", "evt-1", null],
        ["s3", "2026-06-18", "failed", null, "PublisherAuthError (401)"],
        ["s4", "2026-06-19", "failed", "evt-2", "PublisherTransientError (503)"],
      ];
      for (const [id, date, status, remote, err] of rows) {
        sqlite
          .prepare(
            `INSERT INTO "ScheduledWorkout" (id, workoutId, date, status, externalId, remoteEventId, lastError, publishedAt, createdAt, updatedAt)
             VALUES (?, 'w1', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, date, status, `wristplan-${id}`, remote, err, remote ? T : null, T, T);
      }
    };

    const dump = (sqlite: DatabaseSync, cols: Record<string, string>) =>
      Object.fromEntries(
        tables.map((name) => [
          name,
          sqlite.prepare(`SELECT ${cols[name] ?? "*"} FROM "${name}" ORDER BY id`).all(),
        ]),
      );
    const master = (sqlite: DatabaseSync) =>
      sqlite
        .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`)
        .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];

    it("preserves every row byte for byte and changes only the new columns and index", () => {
      migrate(file, PREVIOUS);
      const sqlite = new DatabaseSync(file);
      try {
        seed(sqlite);
        const cols = Object.fromEntries(
          tables.map((n) => [
            n,
            (sqlite.prepare(`PRAGMA table_info("${n}")`).all() as { name: string }[])
              .map((c) => `"${c.name}"`)
              .join(", "),
          ]),
        );
        const before = dump(sqlite, cols);
        const masterBefore = master(sqlite);
        expect(before.ScheduledWorkout).toHaveLength(4);

        sqlite.exec(readFileSync(NEW_MIGRATION, "utf8"));

        expect(dump(sqlite, cols)).toEqual(before);
        expect(
          sqlite.prepare(`SELECT hex(fitFile) AS h FROM "Activity" WHERE id = 'a1'`).get(),
        ).toEqual({ h: "000102FEFF00102E464954" });
        expect(
          sqlite
            .prepare(
              `SELECT count(*) AS n FROM "ScheduledWorkout" WHERE linkedGarminActivityId IS NOT NULL OR matchSource IS NOT NULL`,
            )
            .get(),
        ).toEqual({ n: 0 });

        const after = master(sqlite);
        const byName = (list: typeof after) => new Map(list.map((e) => [`${e.type}:${e.name}`, e]));
        const old = byName(masterBefore);
        const added = after.filter((e) => !old.has(`${e.type}:${e.name}`)).map((e) => e.name);
        expect(added).toEqual(["ScheduledWorkout_linkedGarminActivityId_key"]);
        const changed = after.filter((e) => {
          const prev = old.get(`${e.type}:${e.name}`);
          return prev !== undefined && prev.sql !== e.sql;
        });
        expect(changed.map((e) => e.name)).toEqual(["ScheduledWorkout"]);
        expect(after).toHaveLength(masterBefore.length + 1);
        expect(changed[0]?.sql).toContain('"linkedGarminActivityId" TEXT');
        expect(changed[0]?.sql).toContain('"matchSource" TEXT');
        expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        sqlite.close();
      }
    });

    it("fails loudly and changes nothing when the SQL is applied a second time", () => {
      migrate(file);
      const sqlite = new DatabaseSync(file);
      try {
        const before = master(sqlite);
        expect(() => sqlite.exec(readFileSync(NEW_MIGRATION, "utf8"))).toThrow(/duplicate column/);
        expect(master(sqlite)).toEqual(before);
      } finally {
        sqlite.close();
      }
      // The helper has no applied-migrations table: re-running the whole chain also fails.
      expect(() => migrate(file)).toThrow(/already exists/);
    });
  });
});
