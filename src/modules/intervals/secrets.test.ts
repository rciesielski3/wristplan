import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { BASIC, input, KEY, reply, setup, TOKEN } from "../../../test/intervals-helpers.js";
import { createIntervalsClient, IntervalsConfigError, loadIntervalsConfig } from "./index.js";

type Scenario = { name: string; run: () => Promise<unknown> | unknown };

const failingFetch = (r: () => Response | Promise<Response>) =>
  createIntervalsClient({
    apiKey: KEY,
    athleteId: "0",
    fetch: vi.fn<typeof fetch>().mockImplementation(async () => r()),
  });

const http =
  (status: number, body: string, op: "create" | "delete" = "create"): Scenario["run"] =>
  () => {
    const client = failingFetch(() => reply(status, body));
    return op === "create" ? client.createWorkout(input) : client.deleteWorkout(7);
  };

const scenarios: Scenario[] = [
  { name: "401 echoing the key", run: http(401, `invalid key ${KEY}`) },
  { name: "401 json echoing the key", run: http(401, JSON.stringify({ error: KEY })) },
  { name: "403 echoing key twice", run: http(403, `${KEY}${KEY}`) },
  { name: "429 echoing key", run: http(429, `slow down ${KEY}`) },
  { name: "500 echoing key on delete", run: http(500, `${KEY}`, "delete") },
  { name: "404 echoing key", run: http(404, `no event ${KEY}`, "delete") },
  { name: "key straddling the truncation boundary", run: http(500, `${"a".repeat(195)}${KEY}`) },
  { name: "malformed json containing key", run: http(200, `{"k":"${KEY}"`) },
  { name: "valid json of wrong shape containing key", run: http(200, JSON.stringify({ id: KEY })) },
  {
    name: "network error with key in message",
    run: () =>
      createIntervalsClient({
        apiKey: KEY,
        athleteId: "0",
        fetch: vi
          .fn<typeof fetch>()
          .mockRejectedValue(new Error(`connect failed for ${BASIC} ${KEY}`)),
      }).createWorkout(input),
  },
  {
    name: "validation error with key as externalId",
    run: () => setup().client.createWorkout({ ...input, date: "bad", externalId: KEY }),
  },
  { name: "validation error on delete", run: () => setup().client.deleteWorkout(Number.NaN) },
  { name: "401 echoing full Authorization header", run: http(401, `Authorization: ${BASIC}`) },
  {
    name: "403 echoing json header",
    run: http(403, JSON.stringify({ headers: { Authorization: BASIC } })),
  },
  { name: "token straddling truncation boundary", run: http(500, `${"a".repeat(190)}${BASIC}`) },
  { name: "missing config", run: () => loadIntervalsConfig({ INTERVALS_ATHLETE_ID: KEY }) },
];

const leakingScenarios: Scenario[] = [
  { name: "500 echoing bare base64 token", run: http(500, `token=${TOKEN}`) },
  { name: "500 echoing lowercase scheme", run: http(500, `authorization: basic ${TOKEN}`) },
  {
    name: "failure while reading the body with key in message",
    run: () =>
      failingFetch(
        () =>
          ({
            ok: true,
            status: 200,
            text: () => Promise.reject(new Error(KEY)),
          }) as unknown as Response,
      ).deleteWorkout(7),
  },
];

const basicTextScenarios: Scenario[] = [
  { name: "401 with a WWW-Authenticate Basic realm", run: http(401, 'Basic realm="intervals"') },
];

const surfaces = (e: unknown): Record<string, string> => ({
  message: e instanceof Error ? e.message : "",
  string: String(e),
  json: JSON.stringify(e),
  inspect: inspect(e, { depth: 10, showHidden: true }),
  stack: e instanceof Error ? (e.stack ?? "") : "",
});

const capture = async (s: Scenario) => {
  try {
    await s.run();
  } catch (e) {
    return e;
  }
  throw new Error(`scenario "${s.name}" did not fail`);
};

describe("secret hygiene: key and base64 token never appear in any error surface", () => {
  it.each(scenarios)("$name", async (s) => {
    const e = await capture(s);
    for (const [surface, text] of Object.entries(surfaces(e))) {
      expect(text, surface).not.toContain(KEY);
      expect(text, surface).not.toContain(TOKEN);
    }
  });

  it.each(leakingScenarios)("(known defect) $name", async (s) => {
    const e = await capture(s);
    for (const [surface, text] of Object.entries(surfaces(e))) {
      expect(text, surface).not.toContain(KEY);
      expect(text, surface).not.toContain(TOKEN);
    }
  });
});

describe("secret hygiene: no Basic credentials text in errors", () => {
  it.each(scenarios)("$name", async (s) => {
    const e = await capture(s);
    for (const [surface, text] of Object.entries(surfaces(e))) {
      expect(text, surface).not.toContain("Basic ");
    }
  });
});

describe("secret hygiene: Basic scheme text", () => {
  it.each(basicTextScenarios)("(known defect) $name", async (s) => {
    const e = await capture(s);
    for (const [surface, text] of Object.entries(surfaces(e))) {
      expect(text, surface).not.toContain("Basic ");
    }
  });
});

describe("secret hygiene: client and config objects", () => {
  it("client never exposes the key, token or scheme when serialised or inspected", () => {
    const { client } = setup();
    for (const text of [
      JSON.stringify(client),
      String(client),
      inspect(client, { depth: 10, showHidden: true }),
    ]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("Basic ");
    }
  });

  it("config error names only the variable", () => {
    const err = (() => {
      try {
        loadIntervalsConfig({});
      } catch (e) {
        return e as IntervalsConfigError;
      }
      throw new Error("no throw");
    })();
    expect(err.variable).toBe("INTERVALS_API_KEY");
    expect(err.message).toBe("Missing required environment variable INTERVALS_API_KEY");
  });

  it.each([undefined, ""])("config rejects api key %j", (v) => {
    expect(() => loadIntervalsConfig({ INTERVALS_API_KEY: v })).toThrow(IntervalsConfigError);
  });

  it("config treats an empty athlete id as the default", () => {
    expect(
      loadIntervalsConfig({ INTERVALS_API_KEY: "k", INTERVALS_ATHLETE_ID: "" }).athleteId,
    ).toBe("0");
  });

  it("(known defect) config rejects a whitespace-only api key", () => {
    expect(() => loadIntervalsConfig({ INTERVALS_API_KEY: "   " })).toThrow(IntervalsConfigError);
  });
});

describe("config trimming", () => {
  it("returns the api key trimmed", () => {
    expect(loadIntervalsConfig({ INTERVALS_API_KEY: "  k  " }).apiKey).toBe("k");
  });
});
