import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDb, type Db } from "../src/lib/db/index";

const MIGRATIONS = new URL("../prisma/migrations/", import.meta.url);

export function migrate(file: string): void {
  const sqlite = new DatabaseSync(file);
  try {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const name of dirs) {
      sqlite.exec(readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS), "utf8"));
    }
  } finally {
    sqlite.close();
  }
}

export interface TestDb {
  readonly db: Db;
  readonly dir: string;
  cleanup(): Promise<void>;
}

export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "wristplan-db-"));
  const file = join(dir, "test.db");
  migrate(file);
  const db = createDb(`file:${file}`);
  return {
    db,
    dir,
    async cleanup() {
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
