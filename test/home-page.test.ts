import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../src/lib/db";
import { migrate } from "./db-helpers";

// Renders the real home page and layout against throwaway sqlite files, with next/* and the env
// mocked. Nothing here reads .env, the dev database or the network.
const KEYS = {
  GARMIN_PERSONAL_API_KEY: "zzqq-garmin<&>",
  INTERVALS_API_KEY: "zzqq-intervals",
  INTERVALS_ATHLETE_ID: "izzqq1",
};

let dir: string;
let db: Db;
let env: Record<string, string | undefined>;
const fetchSpy = vi.fn(() => Promise.reject(new Error("no network in tests")));

async function setup(opts: { migrated: boolean; env?: Record<string, string | undefined> }) {
  const file = join(dir, "page.db");
  if (opts.migrated) migrate(file);
  db = createDb(`file:${file}`);
  env = { DATABASE_URL: `file:${file}`, ...(opts.env ?? {}) };
  vi.doMock("next/server", () => ({ connection: async () => undefined }));
  vi.doMock("next/headers", () => ({ headers: async () => ({ get: () => "127.0.0.1:3000" }) }));
  vi.doMock("../src/lib/env", () => ({ getEnv: () => env }));
  vi.doMock("../src/lib/db", () => ({ getDb: () => db }));
  // Client components need the Next router; the Sync button stays a label so it can never fire.
  vi.doMock("../src/app/SyncButton", () => ({
    SyncButton: () => createElement("span", null, "Sync now"),
  }));
  vi.doMock("../src/app/SideNav", () => ({ SideNav: () => createElement("nav") }));
}
const renderPage = async () => {
  const { default: Page } = await import("../src/app/page");
  return renderToStaticMarkup(await Page());
};
const renderLayout = async () => {
  const { default: Layout } = await import("../src/app/layout");
  return renderToStaticMarkup(await Layout({ children: createElement("p", null, "child") }));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wristplan-home-"));
  vi.stubGlobal("fetch", fetchSpy);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 5, 17, 12, 0, 0)); // Wednesday noon, server-local
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const m of [
    "next/server",
    "next/headers",
    "../src/lib/env",
    "../src/lib/db",
    "../src/app/SyncButton",
    "../src/app/SideNav",
  ]) {
    vi.doUnmock(m);
  }
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
  fetchSpy.mockClear();
});

describe("home page", () => {
  it("renders only the checklist on an unmigrated database, without leaking values", async () => {
    await setup({ migrated: false, env: KEYS });
    const html = await renderPage();
    expect(html).toContain("Get started");
    expect(html).toContain("Database migrated");
    expect(html).toContain("2 of 6");
    for (const absent of ["Today", "This week", "Last 8 weeks", "Sync now", "Activities"]) {
      expect(html).not.toContain(absent);
    }
    expect(html).not.toContain("zzqq");

    const layout = await renderLayout();
    expect(layout).toContain("Database: Not migrated");
    expect(layout).toContain("Garmin key: Added");
    expect(layout).not.toContain("zzqq");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an empty migrated database with no keys shows the checklist but no overview cards", async () => {
    await setup({ migrated: true });
    const html = await renderPage();
    expect(html).toContain("1 of 6");
    expect(html).toContain("Sync now");
    expect(html).not.toContain("This week");
    expect(html).not.toContain("Last 8 weeks");
  });

  it("shows the overview once an activity exists and never leaks values", async () => {
    await setup({ migrated: true, env: KEYS });
    await db.activity.create({
      data: {
        garminActivityId: "9",
        startTime: new Date("2026-06-16T08:00:00Z"),
        lastSyncedAt: new Date("2026-06-17T00:00:00Z"),
        durationSeconds: 3600,
        distanceMeters: 10000,
      },
    });
    const html = await renderPage();
    expect(html).toContain("Get started");
    expect(html).toContain("This week");
    expect(html).toContain("Last 8 weeks");
    expect(html).toContain("10.00 km");
    expect(html).toContain("Nothing planned");
    expect(html).not.toContain("zzqq");
    expect(await renderLayout()).not.toContain("zzqq");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a layout with an unreachable database still renders the shell", async () => {
    await setup({ migrated: false });
    await db.$disconnect();
    env = { DATABASE_URL: `file:${join(dir, "missing", "x.db")}`, ...KEYS };
    db = createDb(env.DATABASE_URL ?? "");
    const layout = await renderLayout();
    expect(layout).toContain("child");
    expect(layout).toContain("Database: Not migrated");
    expect(layout).not.toContain("zzqq");
  });
});
