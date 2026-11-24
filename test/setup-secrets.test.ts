import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checklist } from "../src/app/HomeCards";
import { SetupBlock } from "../src/app/SetupBlock";
import type { Db } from "../src/lib/db";
import {
  buildChecklist,
  buildSidebarView,
  getSetupStatus,
  loadSetupCounts,
  NOT_READY,
  type SetupCounts,
  type SetupEnv,
} from "../src/modules/setup";

const READY: SetupCounts = {
  databaseReady: true,
  activityCount: 2,
  workoutCount: 1,
  scheduledCount: 1,
  lastSync: { status: "succeeded", startedAt: new Date("2026-06-01T10:00:00Z") },
};

// Fake, low-entropy values; the special characters would survive JSON and HTML encoding in a
// recognisable form if they ever leaked (they are also checked in their escaped forms).
const SPECIAL = {
  GARMIN_PERSONAL_API_KEY: `zzqq-gk<script>&"'\\/%00 ünï`,
  INTERVALS_API_KEY: `zzqq-ik{{}}$(x)\n\t;--`,
  DATABASE_URL: "file:./zzqq-private-path.db",
  INTERVALS_ATHLETE_ID: "izzqq123",
};
const LONG = "zzqq".repeat(5000);

const forms = (v: string) => [
  v,
  JSON.stringify(v).slice(1, -1),
  encodeURIComponent(v),
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;"),
];

function everything(env: SetupEnv, counts: SetupCounts): string {
  const status = getSetupStatus(env, counts);
  const checklist = buildChecklist(status);
  const sidebar = buildSidebarView(status);
  return [
    JSON.stringify([status, checklist, sidebar]),
    renderToStaticMarkup(createElement(SetupBlock, { status })),
    renderToStaticMarkup(createElement(Checklist, { view: checklist })),
  ].join("\n");
}

describe("setup output never contains configuration values", () => {
  it.each([
    ["special characters", SPECIAL],
    ["very long values", { ...SPECIAL, GARMIN_PERSONAL_API_KEY: LONG, INTERVALS_API_KEY: LONG }],
  ])("%s, with extra env entries present", (_name, env) => {
    for (const counts of [READY, NOT_READY]) {
      const out = everything(env, counts);
      for (const secret of Object.values(env)) {
        for (const form of forms(secret)) expect(out).not.toContain(form);
      }
      expect(out).not.toContain("zzqq");
    }
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace only", " \t\n "],
  ])("%s keys count as missing and render as missing", (_n, value) => {
    const env = { GARMIN_PERSONAL_API_KEY: value, INTERVALS_API_KEY: value };
    const status = getSetupStatus(env, READY);
    expect(status).toMatchObject({ garminKeyConfigured: false, intervalsKeyConfigured: false });
    const html = renderToStaticMarkup(createElement(SetupBlock, { status }));
    expect(html).toContain("Garmin key: Missing");
    expect(html).toContain("intervals.icu key: Missing");
  });

  it("a one-character key still counts as added and exposes no value", () => {
    const status = getSetupStatus({ GARMIN_PERSONAL_API_KEY: "q" }, READY);
    expect(status.garminKeyConfigured).toBe(true);
    expect(Object.keys(status).sort()).toEqual([
      "activityCount",
      "databaseReady",
      "garminKeyConfigured",
      "intervalsKeyConfigured",
      "lastSync",
      "scheduledCount",
      "workoutCount",
    ]);
  });

  it("the status carries only booleans, counts and the last sync summary", () => {
    const status = getSetupStatus(SPECIAL, READY);
    for (const [key, value] of Object.entries(status)) {
      if (key === "lastSync") continue;
      expect(["boolean", "number"]).toContain(typeof value);
    }
    expect(Object.keys(status.lastSync ?? {}).sort()).toEqual(["startedAt", "status"]);
  });
});

const MESSAGE = "zzqq SQLITE_CANTOPEN file:./zzqq-private-path.db token=zzqq";
const MSG_ENV = "zzqq invalid DATABASE_URL=file:./zzqq-private-path.db";

// Every model method rejects with a message full of values that must never surface.
const failing = (): Db => {
  const reject = () => Promise.reject(new Error(MESSAGE));
  return new Proxy({}, { get: () => new Proxy({}, { get: () => reject }) }) as Db;
};

describe("loadSetupCounts error path", () => {
  it("a failing database reports not ready and never echoes the error", async () => {
    const counts = await loadSetupCounts(failing());
    expect(counts).toEqual(NOT_READY);
    expect(JSON.stringify(counts)).not.toContain("zzqq");
    expect(everything({}, counts)).not.toContain("zzqq");
  });

  it.each(["activity", "workout", "syncRun"])(
    "a failure after the migration probe (%s) is contained too",
    async (model) => {
      const ok = { findFirst: async () => null, count: async () => 0 };
      const bad = {
        findFirst: () => Promise.reject(new Error(MESSAGE)),
        count: () => Promise.reject(new Error(MESSAGE)),
      };
      const db = { scheduledWorkout: ok, activity: ok, workout: ok, syncRun: ok, [model]: bad };
      expect(await loadSetupCounts(db as unknown as Db)).toEqual(NOT_READY);
    },
  );

  it("a synchronous throw is also contained", async () => {
    const db = {
      get scheduledWorkout(): never {
        throw new Error(MESSAGE);
      },
    } as unknown as Db;
    expect(await loadSetupCounts(db)).toEqual(NOT_READY);
  });
});

describe("loadSetupStatus (layout loader)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("next/headers");
    vi.doUnmock("../src/lib/env");
    vi.doUnmock("../src/lib/db");
  });

  async function load(opts: { env: () => unknown; host: string | null; db?: () => unknown }) {
    vi.doMock("next/headers", () => ({ headers: async () => ({ get: () => opts.host }) }));
    vi.doMock("../src/lib/env", () => ({ getEnv: opts.env }));
    vi.doMock("../src/lib/db", () => ({ getDb: opts.db ?? failing }));
    const { loadSetupStatus } = await import("../src/app/setupDeps");
    return loadSetupStatus();
  }

  it("a broken environment yields a not-ready status without the error text", async () => {
    const status = await load({
      env: () => {
        throw new Error(MSG_ENV);
      },
      host: "127.0.0.1:3000",
    });
    expect(status).toMatchObject({ databaseReady: false, garminKeyConfigured: false });
    expect(JSON.stringify(status)).not.toContain("zzqq");
  });

  it("a disallowed host yields no status at all", async () => {
    const status = await load({
      env: () => ({ ...SPECIAL, ALLOWED_HOSTS: undefined }),
      host: "evil.example",
    });
    expect(status).toBeNull();
  });

  it("an allowed host with a failing database never leaks values", async () => {
    const status = await load({
      env: () => ({ ...SPECIAL, ALLOWED_HOSTS: undefined }),
      host: "127.0.0.1:3000",
    });
    expect(status).toMatchObject({
      databaseReady: false,
      garminKeyConfigured: true,
      intervalsKeyConfigured: true,
    });
    expect(JSON.stringify(status)).not.toContain("zzqq");
  });
});
