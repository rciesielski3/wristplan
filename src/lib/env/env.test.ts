import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvError, getEnv, parseEnv } from "./index";

const SECRET = "fake-secret-value";
const DB = { DATABASE_URL: "file:./x.db" };
const defaults = { ...DB, INTERVALS_ATHLETE_ID: "0", NODE_ENV: "development" };

function failure(env: unknown): EnvError {
  try {
    parseEnv(env as Record<string, string>);
  } catch (error) {
    if (error instanceof EnvError) return error;
    throw error;
  }
  throw new Error("expected EnvError");
}

const reasons = (reason: string, names: string[]) =>
  `Invalid environment: ${names.map((n) => `${n} (${reason})`).join(", ")}`;
const invalid = (...names: string[]) => reasons("invalid", names);
const missing = (...names: string[]) => reasons("missing", names);

describe("parseEnv valid", () => {
  it("accepts a minimal env and applies defaults", () => {
    expect(parseEnv(DB)).toEqual(defaults);
  });

  it("trims and keeps provided values", () => {
    expect(
      parseEnv({
        DATABASE_URL: " file:./x.db\n",
        INTERVALS_API_KEY: `  ${SECRET} `,
        GARMIN_PERSONAL_API_KEY: "fake-garmin-value",
        INTERVALS_ATHLETE_ID: " i123 ",
        NODE_ENV: "production",
      }),
    ).toEqual({
      DATABASE_URL: "file:./x.db",
      INTERVALS_API_KEY: SECRET,
      GARMIN_PERSONAL_API_KEY: "fake-garmin-value",
      INTERVALS_ATHLETE_ID: "i123",
      NODE_ENV: "production",
    });
  });

  it.each(["", "   ", "\t\n"])("treats blank %j as absent or default", (blank) => {
    const env = parseEnv({
      ...DB,
      INTERVALS_API_KEY: blank,
      GARMIN_PERSONAL_API_KEY: blank,
      INTERVALS_ATHLETE_ID: blank,
      NODE_ENV: blank,
    });
    expect(env).toEqual(defaults);
  });

  it.each(["development", "test", "production"])("accepts NODE_ENV %s", (value) => {
    expect(parseEnv({ ...DB, NODE_ENV: value }).NODE_ENV).toBe(value);
  });

  it.each(["a", "A_b-9", "i123", "0"])("accepts athlete id %j", (value) => {
    expect(parseEnv({ ...DB, INTERVALS_ATHLETE_ID: value }).INTERVALS_ATHLETE_ID).toBe(value);
  });

  it.each(["file:./x.db", "file:/abs/x.db", "file:x.db", "file:./a b.db", "file:../x.db"])(
    "accepts DATABASE_URL %j",
    (url) => {
      expect(parseEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
    },
  );
});

describe("parseEnv invalid", () => {
  it.each([
    ["DATABASE_URL", "postgres://host/db"],
    ["DATABASE_URL", "FILE:./x"],
    ["DATABASE_URL", "file"],
    ["DATABASE_URL", "file:"],
    ["DATABASE_URL", "file: "],
    ["INTERVALS_ATHLETE_ID", "../x"],
    ["INTERVALS_ATHLETE_ID", "a b"],
    ["INTERVALS_ATHLETE_ID", "a/b"],
    ["INTERVALS_ATHLETE_ID", "é"],
    ["NODE_ENV", "staging"],
    ["NODE_ENV", "Production"],
  ])("rejects %s=%j", (name, value) => {
    expect(failure({ ...DB, [name]: value }).message).toBe(invalid(name));
  });

  it.each([undefined, "", "  \t"])("reports missing DATABASE_URL for %j", (value) => {
    expect(failure({ DATABASE_URL: value }).message).toBe(missing("DATABASE_URL"));
    expect(failure({ DATABASE_URL: value, NODE_ENV: "staging" }).message).toBe(
      "Invalid environment: DATABASE_URL (missing), NODE_ENV (invalid)",
    );
  });

  it.each([5, ["x"], {}, true, null])("rejects non-string value %j without coercing", (value) => {
    for (const name of [
      "DATABASE_URL",
      "INTERVALS_API_KEY",
      "GARMIN_PERSONAL_API_KEY",
      "INTERVALS_ATHLETE_ID",
      "NODE_ENV",
    ]) {
      expect(failure({ ...DB, [name]: value }).message).toBe(invalid(name));
    }
  });

  it("lists every failing variable", () => {
    expect(
      failure({ DATABASE_URL: "x", INTERVALS_ATHLETE_ID: "../x", NODE_ENV: "staging" }).message,
    ).toBe(invalid("DATABASE_URL", "INTERVALS_ATHLETE_ID", "NODE_ENV"));
  });

  it("reports a non-object source against env", () => {
    expect(failure(null).message).toBe(invalid("env"));
  });
});

describe("EnvError never leaks input", () => {
  const hostile = [
    SECRET,
    ` \n\t${SECRET}\r\n `,
    `${SECRET}‮\u0000\u{1f511}`,
    `DATABASE_URL missing ${SECRET}`,
    SECRET.repeat(2000),
  ];
  const fields: Record<string, (v: string) => unknown> = {
    DATABASE_URL: (v) => `postgres://user:${v}@host/db`,
    INTERVALS_ATHLETE_ID: (v) => `${v}/..`,
    NODE_ENV: (v) => `x${v}`,
    INTERVALS_API_KEY: (v) => [v],
    GARMIN_PERSONAL_API_KEY: (v) => ({ toString: () => v, secret: v }),
  };

  for (const [name, build] of Object.entries(fields)) {
    it.each(hostile)(`${name} with hostile value %#`, (value) => {
      const error = failure({ ...DB, [name]: build(value) });
      expect(error.message).toBe(invalid(name));
      expect(error.cause).toBeUndefined();
      const surfaces = [
        error.message,
        String(error),
        JSON.stringify(error),
        inspect(error, { depth: 10, showHidden: true }),
        error.stack ?? "",
        JSON.stringify(Object.getOwnPropertyNames(error).map((k) => Reflect.get(error, k))),
      ];
      for (const text of surfaces) expect(text).not.toContain(SECRET);
    });
  }
});

describe("environment access", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => vi.stubEnv("DATABASE_URL", "file:./env.db"));

  it("parseEnv ignores process.env when a source is given", () => {
    vi.stubEnv("DATABASE_URL", "postgres://ignored");
    expect(parseEnv({ DATABASE_URL: "file:./a.db" }).DATABASE_URL).toBe("file:./a.db");
  });

  it("getEnv does not cache a failure, then caches the first success", () => {
    vi.stubEnv("NODE_ENV", "staging");
    expect(() => getEnv()).toThrow(EnvError);
    vi.stubEnv("NODE_ENV", "test");
    const first = getEnv();
    vi.stubEnv("NODE_ENV", "production");
    expect(getEnv()).toBe(first);
    expect(first.NODE_ENV).toBe("test");
  });
});
