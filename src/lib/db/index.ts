import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../generated/prisma/client";
import { getEnv } from "../env";

export type Db = PrismaClient;

export function createDb(url: string): Db {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

let cached: Db | undefined;

export function getDb(): Db {
  cached ??= createDb(getEnv().DATABASE_URL);
  return cached;
}
