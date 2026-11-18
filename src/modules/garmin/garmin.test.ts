import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  activity,
  BASE,
  buildZip,
  callOf,
  JWT,
  JWT2,
  KEY,
  reply,
  setup,
  TOKEN_URL,
} from "../../../test/garmin-helpers";
import {
  createGarminClient,
  GarminApiError,
  GarminAuthError,
  GarminConfigError,
  GarminNetworkError,
  GarminRateLimitError,
  GarminResponseError,
  GarminServerError,
  GarminValidationError,
  loadGarminConfig,
} from "./index";

const FIT = Buffer.from("synthetic-fit-bytes-".repeat(20));
const tokenOk = (jwt = JWT) => reply(200, jwt, { "content-type": "text/plain" });
const list = (body: unknown = [activity]) => reply(200, JSON.stringify(body));
const patchEocdOffset = (zip: Uint8Array, offset: number): Uint8Array => {
  const out = Uint8Array.from(zip);
  const view = new DataView(out.buffer);
  let at = out.length - 22;
  while (view.getUint32(at, true) !== 0x06054b50) at--;
  view.setUint32(at + 16, offset, true);
  return out;
};
const zipRes = (zip: Uint8Array) => reply(200, zip as BodyInit);

describe("config", () => {
  it("trims the key and names the variable on failure", () => {
    expect(loadGarminConfig({ GARMIN_PERSONAL_API_KEY: `  ${KEY} ` })).toEqual({ apiKey: KEY });
    for (const env of [{}, { GARMIN_PERSONAL_API_KEY: "  " }]) {
      const err = (() => {
        try {
          loadGarminConfig(env);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(GarminConfigError);
      expect((err as Error).message).toContain("GARMIN_PERSONAL_API_KEY");
    }
  });

  it("defaults to process.env", () => {
    vi.stubEnv("GARMIN_PERSONAL_API_KEY", KEY);
    expect(loadGarminConfig().apiKey).toBe(KEY);
    vi.unstubAllEnvs();
  });

  it("rejects a blank client key", () => {
    expect(() => createGarminClient({ apiKey: " " })).toThrow(GarminValidationError);
  });
});

describe("token handling", () => {
  it("exchanges the key once and reuses the JWT", async () => {
    const { client, fetchMock } = setup([tokenOk(), list(), list()]);
    await client.listActivities();
    await client.listActivities();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const t = callOf(fetchMock, 0);
    expect(t.url).toBe(TOKEN_URL);
    expect(t.method).toBe("POST");
    expect(t.headers.get("authorization")).toBe(`ApiKey ${KEY}`);
    expect(callOf(fetchMock, 1).headers.get("authorization")).toBe(`Bearer ${JWT}`);
    expect(callOf(fetchMock, 2).headers.get("authorization")).toBe(`Bearer ${JWT}`);
  });

  it("shares one in-flight token request between concurrent calls", async () => {
    const { client, fetchMock } = setup([tokenOk(), list(), list()]);
    await Promise.all([client.listActivities(), client.listActivities()]);
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u) === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
  });

  it("clears the in-flight request after a failure", async () => {
    const { client, fetchMock } = setup([reply(500, "x"), tokenOk(), list()]);
    await expect(client.listActivities()).rejects.toBeInstanceOf(GarminServerError);
    await expect(client.listActivities()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reuses the token well before expiry", async () => {
    let t = 1_000;
    const { client, fetchMock } = setup([tokenOk(), list(), list()], () => t);
    await client.listActivities();
    t += 22 * 3_600_000;
    await client.listActivities();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes the token shortly before 24h", async () => {
    let t = 0;
    const { client, fetchMock } = setup([tokenOk(), list(), tokenOk(JWT2), list()], () => t);
    await client.listActivities();
    t = 23 * 3_600_000;
    await client.listActivities();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(callOf(fetchMock, 3).headers.get("authorization")).toBe(`Bearer ${JWT2}`);
  });

  it("refreshes once on 401 and retries the call", async () => {
    const { client, fetchMock } = setup([tokenOk(), reply(401, "no"), tokenOk(JWT2), list()]);
    await expect(client.listActivities()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(callOf(fetchMock, 3).headers.get("authorization")).toBe(`Bearer ${JWT2}`);
  });

  it("fails with an auth error when 401 persists after refresh", async () => {
    const { client, fetchMock } = setup([
      tokenOk(),
      reply(401, "no"),
      tokenOk(JWT2),
      reply(401, "still no"),
    ]);
    await expect(client.listActivities()).rejects.toBeInstanceOf(GarminAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not refresh twice when concurrent calls both hit 401", async () => {
    const { client, fetchMock } = setup([
      tokenOk(),
      reply(401, "a"),
      reply(401, "b"),
      tokenOk(JWT2),
      list(),
      list(),
    ]);
    await Promise.all([client.listActivities(), client.listActivities()]);
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u) === TOKEN_URL);
    expect(tokenCalls).toHaveLength(2);
  });

  it("maps token endpoint failures", async () => {
    const auth = setup([reply(401, "bad key")]);
    await expect(auth.client.listActivities()).rejects.toBeInstanceOf(GarminAuthError);
    const forbidden = setup([reply(403, "")]);
    await expect(forbidden.client.listActivities()).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a token response that is not a JWT", async () => {
    const { client } = setup([reply(200, '{"token":"x"}')]);
    await expect(client.listActivities()).rejects.toBeInstanceOf(GarminResponseError);
  });
});

describe("listActivities", () => {
  it("sends the query and returns minimal normalised activities", async () => {
    const { client, fetchMock } = setup([tokenOk(), list()]);
    const result = await client.listActivities({
      startDate: "2026-03-01",
      endDate: "2026-03-02",
      start: 0,
      limit: 50,
      sortOrder: "asc",
    });
    const call = callOf(fetchMock, 1);
    expect(call.method).toBe("GET");
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(
      `${BASE}/activitylist-service/activities/search/activities`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      startDate: "2026-03-01",
      endDate: "2026-03-02",
      start: "0",
      limit: "50",
      sortOrder: "asc",
    });
    expect(result).toEqual([
      {
        garminActivityId: "1001",
        name: "Morning Run",
        sport: "running",
        startTime: new Date("2026-03-01T06:30:00Z"),
        durationSeconds: 1800.5,
        distanceMeters: 5000.25,
      },
    ]);
  });

  it("drops every field outside the minimal shape", async () => {
    const { client } = setup([tokenOk(), list()]);
    const [a] = await client.listActivities();
    expect(Object.keys(a ?? {}).sort()).toEqual([
      "distanceMeters",
      "durationSeconds",
      "garminActivityId",
      "name",
      "sport",
      "startTime",
    ]);
    const dump = inspect(a, { depth: 5 });
    for (const pii of ["Test Person", "example.invalid", "ownerId", "startLatitude"]) {
      expect(dump).not.toContain(pii);
    }
  });

  it("keeps missing name, duration and distance null and accepts an empty list", async () => {
    const { client } = setup([
      tokenOk(),
      list([
        { ...activity, activityName: null, distance: null, startTimeGMT: "2026-03-01T06:30:00.0" },
        { ...activity, activityName: undefined, duration: undefined, distance: undefined },
      ]),
      list([]),
    ]);
    const [a, b] = await client.listActivities();
    expect(a).toMatchObject({ name: null, distanceMeters: null, durationSeconds: 1800.5 });
    expect(b).toMatchObject({ name: null, distanceMeters: null, durationSeconds: null });
    await expect(client.listActivities({})).resolves.toEqual([]);
  });

  it.each([
    ["startDate", { startDate: "2026-02-30" }],
    ["endDate", { endDate: "03/01/2026" }],
    ["start", { start: -1 }],
    ["limit", { limit: 0 }],
    ["limit", { limit: 1.5 }],
    ["sortOrder", { sortOrder: "up" as "asc" }],
  ])("rejects invalid %s before any request", async (field, input) => {
    const { client, fetchMock } = setup();
    const err = await client.listActivities(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GarminValidationError);
    expect((err as Error).message).toContain(field);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", reply(200, "<html>")],
    ["not an array", list({ a: 1 })],
    ["bad id", list([{ ...activity, activityId: "1001" }])],
    ["unsafe id", reply(200, '[{"activityId":12345678901234567890}]')],
    ["missing type", list([{ ...activity, activityType: undefined }])],
    ["bad time", list([{ ...activity, startTimeGMT: "yesterday" }])],
    ["impossible date", list([{ ...activity, startTimeGMT: "2026-02-30 00:00:00" }])],
    ["negative duration", list([{ ...activity, duration: -1 }])],
  ])("throws a response error when body is %s", async (_n, res) => {
    const { client } = setup([tokenOk(), res]);
    await expect(client.listActivities()).rejects.toBeInstanceOf(GarminResponseError);
  });
});

describe("error mapping", () => {
  it("maps 429 with retry-after", async () => {
    const { client } = setup([tokenOk(), reply(429, "slow", { "retry-after": "30" })]);
    await expect(client.listActivities()).rejects.toMatchObject({
      name: "GarminRateLimitError",
      status: 429,
      retryAfterSeconds: 30,
    });
  });

  it.each([[{}], [{ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }]])(
    "maps 429 without a numeric retry-after %#",
    async (headers) => {
      const { client } = setup([tokenOk(), reply(429, "", headers)]);
      const err = await client.listActivities().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GarminRateLimitError);
      expect((err as GarminRateLimitError).retryAfterSeconds).toBeUndefined();
    },
  );

  it("maps 5xx, 403 and other statuses", async () => {
    const s = setup([tokenOk(), reply(503, "down")]);
    await expect(s.client.listActivities()).rejects.toBeInstanceOf(GarminServerError);
    const f = setup([tokenOk(), reply(403, "no")]);
    await expect(f.client.listActivities()).rejects.toBeInstanceOf(GarminAuthError);
    const o = setup([tokenOk(), reply(400, "bad")]);
    const err = await o.client.listActivities().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GarminApiError);
    expect(err).not.toBeInstanceOf(GarminAuthError);
  });

  it("maps network failures without a cause", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("boom"));
    const client = createGarminClient({ apiKey: KEY, fetch: fetchMock });
    const err = await client.listActivities().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GarminNetworkError);
    expect((err as GarminNetworkError).timedOut).toBe(false);
    expect((err as Error).cause).toBeUndefined();
    expect((err as Error).message).not.toContain("boom");
  });

  it("flags timeouts", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const client = createGarminClient({
      apiKey: KEY,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(timeout),
      timeoutMs: 5,
    });
    await expect(client.listActivities()).rejects.toMatchObject({ timedOut: true });
  });

  it("flags non-Error rejections as network errors", async () => {
    const client = createGarminClient({
      apiKey: KEY,
      fetch: vi.fn<typeof fetch>().mockRejectedValue("str"),
    });
    await expect(client.listActivities()).rejects.toMatchObject({ timedOut: false });
  });

  it("strips the query from error paths and caps the detail", async () => {
    const { client } = setup([tokenOk(), reply(500, "x".repeat(500))]);
    const err = (await client
      .listActivities({ startDate: "2026-03-01" })
      .catch((e: unknown) => e)) as GarminServerError;
    expect(err.path).toBe("/activitylist-service/activities/search/activities");
    expect(err.message).not.toContain("startDate");
    expect(err.message.length).toBeLessThan(300);
  });
});

describe("secret redaction", () => {
  const bodies = (): [string, string][] => [
    ["key", `echo ${KEY}`],
    ["jwt", `echo ${JWT}`],
    ["bearer header", `Authorization: Bearer ${JWT2}`],
    ["apikey header", `Authorization: ApiKey ${KEY}`],
    ["other jwt", JWT2],
  ];

  it.each(bodies())("never leaks via API error echoing %s", async (_n, body) => {
    const { client } = setup([tokenOk(), reply(500, body)]);
    const err = (await client.listActivities().catch((e: unknown) => e)) as Error;
    for (const secret of [KEY, JWT, JWT2]) {
      expect(err.message).not.toContain(secret);
      expect(inspect(err, { depth: 5 })).not.toContain(secret);
    }
    expect(err.message).toContain("[REDACTED]");
  });

  it("never leaks via token endpoint errors", async () => {
    const { client } = setup([reply(401, `bad ${KEY}`)]);
    const err = (await client.listActivities().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(KEY);
  });

  it("does not put the key or JWT in URLs", async () => {
    const { client, fetchMock } = setup([tokenOk(), list()]);
    await client.listActivities({ limit: 1 });
    for (let i = 0; i < 2; i++) {
      expect(callOf(fetchMock, i).url).not.toContain(KEY);
      expect(callOf(fetchMock, i).url).not.toContain(JWT);
    }
  });
});

describe("downloadActivityFit", () => {
  it.each([
    ["deflated", 8 as const],
    ["stored", 0 as const],
  ])("extracts the FIT from a %s zip", async (_n, method) => {
    const { client, fetchMock } = setup([tokenOk(), zipRes(buildZip(FIT, { method }))]);
    const out = await client.downloadActivityFit("1001");
    expect(Buffer.from(out).equals(FIT)).toBe(true);
    const call = callOf(fetchMock, 1);
    expect(call.url).toBe(`${BASE}/download-service/files/activity/1001`);
    expect(call.headers.get("authorization")).toBe(`Bearer ${JWT}`);
  });

  it("finds the end record behind a zip comment", async () => {
    const { client } = setup([tokenOk(), zipRes(buildZip(FIT, { comment: "hello" }))]);
    await expect(client.downloadActivityFit("1001")).resolves.toHaveLength(FIT.length);
  });

  it.each(["", "12a", "../1", "1/2", "-1", "1".repeat(20), " 1"])(
    "rejects id %j before any request",
    async (id) => {
      const { client, fetchMock } = setup();
      await expect(client.downloadActivityFit(id)).rejects.toBeInstanceOf(GarminValidationError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects non-string ids", async () => {
    const { client } = setup();
    await expect(client.downloadActivityFit(5 as unknown as string)).rejects.toBeInstanceOf(
      GarminValidationError,
    );
  });

  const bad: [string, () => Uint8Array][] = [
    ["empty body", () => new Uint8Array()],
    ["not a zip", () => new TextEncoder().encode("PK nope".repeat(10))],
    ["two entries", () => buildZip(FIT, { entries: 2 })],
    ["path traversal name", () => buildZip(FIT, { name: "../evil.fit" })],
    ["nested name", () => buildZip(FIT, { name: "a/b.fit" })],
    ["non-fit name", () => buildZip(FIT, { name: "1001.txt" })],
    ["encrypted", () => buildZip(FIT, { flags: 1 })],
    ["unsupported method", () => buildZip(FIT, { method: 9, rawData: FIT })],
    ["corrupt deflate", () => buildZip(FIT, { rawData: Buffer.from("zzzzzzzz") })],
    ["size mismatch (stored)", () => buildZip(FIT, { method: 0, declaredSize: FIT.length + 1 })],
    ["size over declared (deflate)", () => buildZip(FIT, { declaredSize: 5 })],
    ["zip64 marker", () => buildZip(FIT, { declaredSize: 0xffffffff })],
    ["entry too large", () => buildZip(FIT, { declaredSize: 60 * 1024 * 1024 })],
    ["truncated", () => buildZip(FIT).subarray(0, 40)],
    ["central offset out of range", () => patchEocdOffset(buildZip(FIT), 0xfffff0)],
    ["central offset not a header", () => patchEocdOffset(buildZip(FIT), 0)],
    [
      "central header cut off",
      () => {
        const z = buildZip(FIT, { comment: "\x50\x4b\x01\x02" });
        return patchEocdOffset(z, z.length - 4);
      },
    ],
    [
      "name length beyond buffer",
      () => {
        const z = buildZip(FIT);
        const view = new DataView(z.buffer, z.byteOffset);
        const cen = view.getUint32(z.length - 22 + 16, true);
        view.setUint16(cen + 28, 60000, true);
        return z;
      },
    ],
  ];

  it.each(bad)("throws a response error for %s", async (_n, make) => {
    const { client } = setup([tokenOk(), zipRes(make())]);
    await expect(client.downloadActivityFit("1001")).rejects.toBeInstanceOf(GarminResponseError);
  });

  it("rejects oversized downloads", async () => {
    const big = new Uint8Array(50 * 1024 * 1024 + 1);
    const { client } = setup([tokenOk(), zipRes(big)]);
    await expect(client.downloadActivityFit("1001")).rejects.toThrow(/size limit/);
  });

  it("reports a bad local header and truncated data", async () => {
    const zip = buildZip(FIT, { method: 0 });
    const badLocal = Uint8Array.from(zip);
    badLocal[0] = 0;
    const cut = buildZip(FIT, { method: 0 });
    const eocdAt = cut.length - 22;
    const view = new DataView(cut.buffer, cut.byteOffset);
    view.setUint32(eocdAt + 16, view.getUint32(eocdAt + 16, true) + 0, true);
    const central = eocdAt - 46 - 17;
    view.setUint32(central + 20, 1_000_000, true);
    view.setUint32(central + 24, FIT.length, true);
    for (const z of [badLocal, cut]) {
      const { client } = setup([tokenOk(), zipRes(z)]);
      await expect(client.downloadActivityFit("1001")).rejects.toBeInstanceOf(GarminResponseError);
    }
  });

  it("maps download HTTP errors", async () => {
    const { client } = setup([tokenOk(), reply(404, "gone")]);
    await expect(client.downloadActivityFit("1001")).rejects.toMatchObject({
      status: 404,
      path: "/download-service/files/activity/1001",
    });
  });
});
