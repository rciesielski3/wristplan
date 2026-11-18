import { defineConfig } from "prisma/config";

// Only `prisma generate` (postinstall, CI) may run without DATABASE_URL: it never opens the
// database. Every other command must use the same DB as the app, so it fails without it.
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  if (process.argv[2] === "generate") return "file:./dev.db";
  throw new Error("DATABASE_URL is required (set it in .env, see .env.example)");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: databaseUrl() },
});
