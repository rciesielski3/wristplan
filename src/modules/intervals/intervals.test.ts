import { describe, expect, it, vi } from "vitest";
import {
  createIntervalsClient,
  IntervalsApiError,
  IntervalsConfigError,
  IntervalsNotFoundError,
  IntervalsResponseError,
  IntervalsValidationError,
  loadIntervalsConfig,
} from "./index.js";

const KEY = "secret-key-123";
const event = {
  id: 7,
  external_id: "wristplan-x-1",
  start_date_local: "2026-01-02T00:00:00",
  push_errors: null,
  name: "n",
};

const reply = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

const setup = (...responses: Response[]) => {
  const fetchMock = vi.fn<typeof fetch>();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  const client = createIntervalsClient({ apiKey: KEY, athleteId: "0", fetch: fetchMock });
  return { client, fetchMock };
};

const input = {
  name: "n",
  date: "2026-01-02",
  type: "Run",
  target: "HR",
  description: "- 10m Z1 HR",
  externalId: "wristplan-x-1",
} as const;

describe("loadIntervalsConfig", () => {
  it("defaults athlete id to 0", () => {
    expect(loadIntervalsConfig({ INTERVALS_API_KEY: "k" })).toEqual({
      apiKey: "k",
      athleteId: "0",
    });
  });
  it("uses provided athlete id", () => {
    expect(
      loadIntervalsConfig({ INTERVALS_API_KEY: "k", INTERVALS_ATHLETE_ID: "i1" }).athleteId,
    ).toBe("i1");
  });
  it("names only the missing variable", () => {
    expect(() => loadIntervalsConfig({})).toThrow(IntervalsConfigError);
    expect(() => loadIntervalsConfig({})).toThrow("INTERVALS_API_KEY");
  });
});

describe("createWorkout", () => {
  it("posts upsert payload with basic auth", async () => {
    const { client, fetchMock } = setup(reply(200, event));
    const result = await client.createWorkout(input);
    expect(result).toEqual({
      id: 7,
      externalId: "wristplan-x-1",
      startDateLocal: "2026-01-02T00:00:00",
      pushErrors: null,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://intervals.icu/api/v1/athlete/0/events?upsertOnUid=true");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from(`API_KEY:${KEY}`).toString("base64")}`,
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      category: "WORKOUT",
      type: "Run",
      name: "n",
      start_date_local: "2026-01-02T00:00:00",
      target: "HR",
      description: "- 10m Z1 HR",
      external_id: "wristplan-x-1",
    });
  });

  it("exposes non-empty push errors", async () => {
    const { client } = setup(reply(200, { ...event, push_errors: ["bad step"] }));
    expect((await client.createWorkout(input)).pushErrors).toEqual(["bad step"]);
  });

  it("treats empty or absent push_errors as none", async () => {
    const { push_errors: _omit, ...noField } = event;
    const { client } = setup(reply(200, { ...event, push_errors: [] }), reply(200, noField));
    expect((await client.createWorkout(input)).pushErrors).toBeNull();
    expect((await client.createWorkout(input)).pushErrors).toBeNull();
  });

  it.each(["2026-1-2", "2026-02-30", "nope"])("rejects invalid date %s", async (date) => {
    const { client, fetchMock } = setup();
    await expect(client.createWorkout({ ...input, date })).rejects.toBeInstanceOf(
      IntervalsValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires externalId", async () => {
    const { client } = setup();
    await expect(client.createWorkout({ ...input, externalId: "" })).rejects.toBeInstanceOf(
      IntervalsValidationError,
    );
  });

  it.each([
    ["array", []],
    ["string id", { ...event, id: "7" }],
    ["bad external_id", { ...event, external_id: 5 }],
    ["bad date", { ...event, start_date_local: 1 }],
    ["bad push_errors", { ...event, push_errors: "x" }],
  ])("rejects malformed response: %s", async (_n, body) => {
    const { client } = setup(reply(200, body));
    await expect(client.createWorkout(input)).rejects.toBeInstanceOf(IntervalsResponseError);
  });

  it("rejects non-JSON and empty bodies", async () => {
    const { client } = setup(reply(200, "<html>"), reply(200, ""));
    await expect(client.createWorkout(input)).rejects.toBeInstanceOf(IntervalsResponseError);
    await expect(client.createWorkout(input)).rejects.toBeInstanceOf(IntervalsResponseError);
  });

  it("never leaks credentials in errors", async () => {
    const authB64 = Buffer.from(`API_KEY:${KEY}`).toString("base64");
    const { client } = setup(reply(401, `bad ${KEY} Basic ${authB64} ${"x".repeat(500)}`));
    const err = await client.createWorkout(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsApiError);
    const api = err as IntervalsApiError;
    expect(api.status).toBe(401);
    expect(api.path).toBe("/athlete/0/events");
    const dump = `${api.message}${JSON.stringify(api)}${String(api)}`;
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain(authB64);
    expect(api.message.length).toBeLessThan(400);
  });

  it("wraps network failures without cause details", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(`boom ${KEY}`));
    const client = createIntervalsClient({ apiKey: KEY, athleteId: "0", fetch: fetchMock });
    const err = await client.createWorkout(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsApiError);
    expect(JSON.stringify(err) + String(err)).not.toContain(KEY);
  });
});

describe("rescheduleWorkout", () => {
  it("gets then puts the full event with new date", async () => {
    const { client, fetchMock } = setup(
      reply(200, event),
      reply(200, { ...event, start_date_local: "2026-02-03T00:00:00" }),
    );
    const result = await client.rescheduleWorkout(7, "2026-02-03");
    expect(result.startDateLocal).toBe("2026-02-03T00:00:00");
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)}`)).toEqual([
      "GET https://intervals.icu/api/v1/athlete/0/events/7",
      "PUT https://intervals.icu/api/v1/athlete/0/events/7",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      ...event,
      start_date_local: "2026-02-03T00:00:00",
    });
  });

  it("validates inputs and surfaces not found", async () => {
    const { client } = setup(reply(404, "nope"));
    await expect(client.rescheduleWorkout(0, "2026-02-03")).rejects.toBeInstanceOf(
      IntervalsValidationError,
    );
    await expect(client.rescheduleWorkout(7, "bad")).rejects.toBeInstanceOf(
      IntervalsValidationError,
    );
    await expect(client.rescheduleWorkout(7, "2026-02-03")).rejects.toBeInstanceOf(
      IntervalsNotFoundError,
    );
  });

  it("rejects malformed GET response before PUT", async () => {
    const { client, fetchMock } = setup(reply(200, { id: "x" }));
    await expect(client.rescheduleWorkout(7, "2026-02-03")).rejects.toBeInstanceOf(
      IntervalsResponseError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("deleteWorkout", () => {
  it("deletes", async () => {
    const { client, fetchMock } = setup(reply(200, ""));
    await expect(client.deleteWorkout(7, { allowForeign: true })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("throws typed not-found on 404", async () => {
    const { client } = setup(reply(404, "gone"));
    const err = await client.deleteWorkout(7, { allowForeign: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsNotFoundError);
    expect(err).toBeInstanceOf(IntervalsApiError);
    expect((err as IntervalsApiError).status).toBe(404);
  });

  it("throws api error on 500 and validates id", async () => {
    const { client } = setup(reply(500, "err"));
    await expect(client.deleteWorkout(7, { allowForeign: true })).rejects.toMatchObject({
      status: 500,
      method: "DELETE",
    });
    await expect(client.deleteWorkout(1.5, { allowForeign: true })).rejects.toBeInstanceOf(
      IntervalsValidationError,
    );
  });
});

describe("client object", () => {
  it("does not expose the api key", () => {
    const { client } = setup();
    expect(JSON.stringify(client) + String(client)).not.toContain(KEY);
  });
});
