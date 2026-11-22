import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../test/db-helpers";

const state: { key: string | undefined; db: unknown } = { key: undefined, db: undefined };
vi.mock("../lib/env", () => ({
  getEnv: () => ({
    INTERVALS_API_KEY: state.key,
    INTERVALS_ATHLETE_ID: "0",
    ALLOWED_HOSTS: undefined,
  }),
}));
vi.mock("../lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/db")>()),
  getDb: () => state.db,
}));

import { ScheduleNotConfiguredError } from "../modules/calendar";
import { scheduleDeps } from "./scheduleDeps";

describe("scheduleDeps", () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
    state.db = t.db;
    state.key = undefined;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("refuses to build a publishing service without an API key", () => {
    expect(() => scheduleDeps().service()).toThrow(ScheduleNotConfiguredError);
  });

  it("builds a link service without an API key", async () => {
    expect(
      await scheduleDeps()
        .linkService()
        .unlink("missing")
        .catch((e: Error) => e.name),
    ).toBe("ScheduleNotFoundError");
  });

  it("builds a publishing service when a key is configured, without any network call", () => {
    state.key = "fake-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(typeof scheduleDeps().service().schedule).toBe("function");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("lists without a key", async () => {
    const items = await scheduleDeps().readService().list({ from: "2026-06-01", to: "2026-06-02" });
    expect(items).toEqual([]);
  });
});
