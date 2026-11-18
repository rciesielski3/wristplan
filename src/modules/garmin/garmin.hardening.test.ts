import { inspect } from "node:util";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activity,
  buildZip,
  callOf,
  JWT,
  JWT2,
  KEY,
  reply,
  setup,
} from "../../../test/garmin-helpers";
import { createGarminClient, GarminNetworkError, GarminResponseError } from "./index";

const FIT = Buffer.from("synthetic-fit-bytes-".repeat(20));
const tokenOk = (jwt = JWT) => reply(200, jwt);
const list = (body: unknown = [activity]) => reply(200, JSON.stringify(body));
const zipRes = (zip: Uint8Array) => reply(200, zip as BodyInit);
const caught = (p: Promise<unknown>) => p.catch((e: unknown) => e) as Promise<Error>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("default transport", () => {
  it("uses the global fetch when none is injected", async () => {
    const g = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(list([]));
    vi.stubGlobal("fetch", g);
    await expect(createGarminClient({ apiKey: KEY }).listActivities()).resolves.toEqual([]);
    expect(g).toHaveBeenCalledTimes(2);
  });
});

describe("secret handling", () => {
  it("redacts and trims a key that was passed with surrounding whitespace", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(reply(500, `echo ${KEY}`));
    const err = await caught(
      createGarminClient({ apiKey: ` ${KEY}\n`, fetch: f }).listActivities(),
    );
    expect(err.message).not.toContain(KEY);
    expect(new Headers(f.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`ApiKey ${KEY}`);
  });

  it("leaks no secret through any property, JSON or cause of any error type", async () => {
    const leaky = new TypeError(`connect failed for ApiKey ${KEY} Bearer ${JWT}`);
    const cases: Promise<Error>[] = [
      caught(setup([reply(401, `${KEY} ${JWT}`)]).client.listActivities()),
      caught(
        setup([
          tokenOk(),
          reply(429, `${KEY} ${JWT}`, { "retry-after": "1" }),
        ]).client.listActivities(),
      ),
      caught(setup([tokenOk(), reply(502, `${KEY} ${JWT}`)]).client.listActivities()),
      caught(setup([tokenOk(), reply(404, `${KEY} ${JWT}`)]).client.downloadActivityFit("1")),
      caught(setup([reply(200, `${KEY}.${JWT}`)]).client.listActivities()),
      caught(
        createGarminClient({
          apiKey: KEY,
          fetch: vi.fn<typeof fetch>().mockRejectedValue(leaky),
        }).listActivities(),
      ),
    ];
    for (const err of await Promise.all(cases)) {
      const dump = [
        err.message,
        err.stack ?? "",
        JSON.stringify(err),
        inspect(err, { depth: 10, showHidden: true }),
        String(err.cause ?? ""),
      ].join("\n");
      for (const secret of [KEY, JWT, JWT2]) expect(dump).not.toContain(secret);
    }
  });

  it("redacts a JWT that was issued earlier and then dropped after a 401", async () => {
    const { client } = setup([
      tokenOk(),
      reply(401, "x"),
      tokenOk(JWT2),
      reply(500, `${JWT} ${JWT2}`),
    ]);
    const err = await caught(client.listActivities());
    expect(err.message).not.toContain(JWT);
    expect(err.message).not.toContain(JWT2);
  });

  it("does not leak a secret that is split by the 200 character cap", async () => {
    const { client } = setup([tokenOk(), reply(500, `${"x".repeat(190)}${KEY}${JWT}`)]);
    const err = await caught(client.listActivities());
    expect(err.message).not.toContain(KEY.slice(0, 10));
    expect(err.message).not.toContain(JWT.slice(0, 10));
  });
});

describe("token cache", () => {
  it("still reuses the token one millisecond before the 23h refresh point", async () => {
    let t = 0;
    const { client, fetchMock } = setup([tokenOk(), list(), list()], () => t);
    await client.listActivities();
    t = 23 * 3_600_000 - 1;
    await client.listActivities();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps using the token when the clock goes backwards and recovers via 401", async () => {
    let t = 10 * 3_600_000;
    const { client, fetchMock } = setup(
      [tokenOk(), list(), reply(401, "expired"), tokenOk(JWT2), list()],
      () => t,
    );
    await client.listActivities();
    t = 0;
    await expect(client.listActivities()).resolves.toHaveLength(1);
    expect(callOf(fetchMock, 2).headers.get("authorization")).toBe(`Bearer ${JWT}`);
    expect(callOf(fetchMock, 4).headers.get("authorization")).toBe(`Bearer ${JWT2}`);
  });

  it("does not cache a failed refresh after a 401 and tries again on the next call", async () => {
    const { client, fetchMock } = setup([
      tokenOk(),
      reply(401, "expired"),
      reply(500, "token down"),
      tokenOk(JWT2),
      list(),
    ]);
    await expect(client.listActivities()).rejects.toMatchObject({ status: 500 });
    await expect(client.listActivities()).resolves.toHaveLength(1);
    expect(callOf(fetchMock, 4).headers.get("authorization")).toBe(`Bearer ${JWT2}`);
  });

  it("does not cache a non-JWT token response", async () => {
    const { client, fetchMock } = setup([reply(200, "<html>"), tokenOk(), list()]);
    await expect(client.listActivities()).rejects.toBeInstanceOf(GarminResponseError);
    await expect(client.listActivities()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not cache a network failure of the token request", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("down"))
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(list());
    const client = createGarminClient({ apiKey: KEY, fetch: f });
    await expect(client.listActivities()).rejects.toBeInstanceOf(GarminNetworkError);
    await expect(client.listActivities()).resolves.toHaveLength(1);
  });

  it("refreshes only once for any interleaving of concurrent 401s", async () => {
    let issued = 0;
    const f = vi.fn<typeof fetch>(async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (String(url).includes("personalapitoken")) return tokenOk(issued++ === 0 ? JWT : JWT2);
      return auth === `Bearer ${JWT2}` ? list() : reply(401, "old");
    });
    const client = createGarminClient({ apiKey: KEY, fetch: f });
    await client.listActivities();
    const results = await Promise.all([
      client.listActivities(),
      client.listActivities(),
      client.downloadActivityFit("1").catch(() => "zip"),
    ]);
    expect(issued).toBe(2);
    expect(results[0]).toHaveLength(1);
  });
});

describe("input validation and URL building", () => {
  it("omits explicitly undefined optional fields from the query string", async () => {
    const { client, fetchMock } = setup([tokenOk(), list([])]);
    await client.listActivities({ startDate: undefined, limit: 5 } as never);
    expect(new URL(callOf(fetchMock, 1).url).search).toBe("?limit=5");
  });

  it.each([
    { startDate: "2026-03-01&limit=1000" },
    { startDate: "2026-03-01#x" },
    { endDate: "2026-03-01\n" },
    { endDate: "2026-3-1" },
    { limit: 1001 },
    { limit: Number.NaN },
    { limit: Number.POSITIVE_INFINITY },
    { start: 2 ** 53 },
    { start: 1.2 },
    { limit: "5" },
    { sortOrder: "asc&x=1" },
  ])("rejects hostile or out-of-range list input %j", async (input) => {
    const { client, fetchMock } = setup();
    await expect(client.listActivities(input as never)).rejects.toMatchObject({
      name: "GarminValidationError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the limit bounds 1 and 1000", async () => {
    const { client, fetchMock } = setup([tokenOk(), list([]), list([])]);
    await client.listActivities({ limit: 1 });
    await client.listActivities({ limit: 1000 });
    expect(new URL(callOf(fetchMock, 2).url).searchParams.get("limit")).toBe("1000");
  });

  it("ignores prototype-style keys in list input", async () => {
    const { client, fetchMock } = setup([tokenOk(), list([])]);
    const input = JSON.parse('{"__proto__":{"limit":7},"constructor":"x","limit":3}');
    await client.listActivities(input);
    expect(new URL(callOf(fetchMock, 1).url).search).toBe("?limit=3");
  });

  it.each(["1?x=1", "1#f", "1%2F", "1\n", "١٢٣", "1 ", "0x10", "1e3", "+1"])(
    "rejects activity id %j without any request",
    async (id) => {
      const { client, fetchMock } = setup();
      await expect(client.downloadActivityFit(id)).rejects.toMatchObject({
        name: "GarminValidationError",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("passes ids above 2^53 through as exact digit strings", async () => {
    const id = "9007199254740993";
    const { client, fetchMock } = setup([tokenOk(), reply(404, "")]);
    await caught(client.downloadActivityFit(id));
    expect(callOf(fetchMock, 1).url).toBe(
      `https://personal.connectapi.garmin.com/download-service/files/activity/${id}`,
    );
  });

  it("keeps every request on the configured origin", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(list([]));
    const client = createGarminClient({
      apiKey: KEY,
      fetch: f,
      baseUrl: "https://example.invalid",
    });
    await client.listActivities({ startDate: "2026-03-01", sortOrder: "desc" });
    for (const [u] of f.mock.calls)
      expect(new URL(String(u)).origin).toBe("https://example.invalid");
  });
});

describe("response shaping", () => {
  it("returns only whitelisted keys even when the payload carries prototype and nested extras", async () => {
    const body =
      '[{"__proto__":{"polluted":1},"constructor":{"x":1},"activityId":7,' +
      '"activityName":"n","activityType":{"typeKey":"running","__proto__":{"y":1},"deep":{"gps":[1,2]}},' +
      '"startTimeGMT":"2026-03-01 06:30:00","duration":1,"distance":2,' +
      '"startLatitude":1.5,"ownerFullName":"Test Person","summaryDTO":{"hr":[1]}}]';
    const { client } = setup([tokenOk(), reply(200, body)]);
    const [a] = await client.listActivities();
    expect(Object.keys(a ?? {}).sort()).toEqual([
      "distanceMeters",
      "durationSeconds",
      "garminActivityId",
      "name",
      "sport",
      "startTime",
    ]);
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(inspect(a, { depth: 10 })).not.toMatch(/gps|Test Person|summaryDTO|polluted/);
  });

  it.each([
    ["array holds null", "[null]"],
    ["activity is an array", "[[]]"],
    ["zero id", JSON.stringify([{ ...activity, activityId: 0 }])],
    ["fractional id", JSON.stringify([{ ...activity, activityId: 1.5 }])],
    ["non-string type key", JSON.stringify([{ ...activity, activityType: { typeKey: 5 } }])],
    ["null start time", JSON.stringify([{ ...activity, startTimeGMT: null }])],
    ["string duration", JSON.stringify([{ ...activity, duration: "10" }])],
    ["hour 24", JSON.stringify([{ ...activity, startTimeGMT: "2026-03-01 24:00:00" }])],
  ])("rejects a list where %s", async (_n, body) => {
    const { client } = setup([tokenOk(), reply(200, body)]);
    await expect(client.listActivities()).rejects.toBeInstanceOf(GarminResponseError);
  });
});

describe("timeouts and aborts", () => {
  const hang: typeof fetch = (_u, init) =>
    new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(init.signal?.reason));
    });

  it("sends an abort signal with every request", async () => {
    const { client, fetchMock } = setup([tokenOk(), list([])]);
    await client.listActivities();
    for (let i = 0; i < 2; i++)
      expect(fetchMock.mock.calls[i]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a request that exceeds timeoutMs as a timeout without leaking details", async () => {
    const client = createGarminClient({ apiKey: KEY, fetch: hang, timeoutMs: 1 });
    const err = await caught(client.listActivities());
    expect(err).toBeInstanceOf(GarminNetworkError);
    expect(err).toMatchObject({
      timedOut: true,
      path: "/personalapitoken-service/personal-api/personal-api-key/token",
    });
    expect(err.message).toContain("timeout");
  });

  it("maps a body stream that dies mid-download to a network error", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.error(new Error(`broken ${KEY}`));
      },
    });
    const { client } = setup([tokenOk(), new Response(stream, { status: 200 })]);
    const err = await caught(client.downloadActivityFit("1"));
    expect(err).toBeInstanceOf(GarminNetworkError);
    expect(err.message).not.toContain(KEY);
  });

  it("does not retry after a timeout", async () => {
    const f = vi.fn<typeof fetch>(hang);
    const client = createGarminClient({ apiKey: KEY, fetch: f, timeoutMs: 1 });
    await caught(client.listActivities());
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("zip hardening", () => {
  const reject = async (zip: Uint8Array, reason?: RegExp) => {
    const { client } = setup([tokenOk(), zipRes(zip)]);
    const err = await caught(client.downloadActivityFit("1"));
    expect(err).toBeInstanceOf(GarminResponseError);
    if (reason) expect(err.message).toMatch(reason);
  };

  it.each([
    ["null byte", "1001\0.fit"],
    ["null byte before extension", "a\0b.fit"],
    ["trailing newline", "1001.fit\n"],
    ["backslash traversal", "..\\evil.fit"],
    ["absolute path", "/etc/x.fit"],
    ["unicode", "ａ.fit"],
    ["double extension", "x.fit.exe"],
    ["only extension", ".fit"],
    ["empty", ""],
  ])("rejects entry name with %s", async (_n, name) => {
    await reject(buildZip(FIT, { name }), /entry name/);
  });

  it("rejects a decompression bomb whose declared size lies, without inflating it", async () => {
    const bomb = Buffer.alloc(30 * 1024 * 1024);
    await reject(buildZip(bomb, { declaredSize: 100 }), /deflate/);
  });

  it("rejects a bomb declared above the output cap before inflating", async () => {
    await reject(buildZip(FIT, { declaredSize: 50 * 1024 * 1024 + 1 }), /size limit/);
  });

  it("accepts an honest large highly-compressible entry within the cap", async () => {
    const big = Buffer.alloc(8 * 1024 * 1024, 7);
    const { client } = setup([tokenOk(), zipRes(buildZip(big))]);
    await expect(client.downloadActivityFit("1")).resolves.toHaveLength(big.length);
  });

  it("rejects an entry whose real data is shorter than declared", async () => {
    await reject(buildZip(FIT, { declaredSize: FIT.length + 500 }), /mismatch/);
  });

  it("rejects an archive that declares more than one entry", async () => {
    await reject(buildZip(FIT, { entries: 2 }), /exactly one/);
    await reject(buildZip(FIT, { entries: 0 }), /exactly one/);
  });

  it("rejects an archive whose compressed size points past the buffer", async () => {
    const z = buildZip(FIT, { method: 0 });
    const view = new DataView(z.buffer, z.byteOffset);
    const cen = view.getUint32(z.length - 22 + 16, true);
    view.setUint32(cen + 20, 0xfffffff0, true);
    await reject(z, /truncated/);
  });

  it("rejects a zip64 compressed size or local offset marker", async () => {
    const make = (field: number) => {
      const z = buildZip(FIT, { method: 0 });
      const view = new DataView(z.buffer, z.byteOffset);
      view.setUint32(view.getUint32(z.length - 22 + 16, true) + field, 0xffffffff, true);
      return z;
    };
    await reject(make(20), /zip64/);
    await reject(make(42), /zip64/);
  });

  it("accepts entries that use a trailing data descriptor flag", async () => {
    const { client } = setup([tokenOk(), zipRes(buildZip(FIT, { flags: 8 }))]);
    const out = await client.downloadActivityFit("1");
    expect(Buffer.from(out).equals(FIT)).toBe(true);
  });

  it("rejects zero-byte and sub-minimum archives", async () => {
    await reject(new Uint8Array(0));
    await reject(new Uint8Array(21));
  });

  it("rejects a truncated deflate stream", async () => {
    await reject(buildZip(FIT, { rawData: deflateRawSync(FIT).subarray(0, 5) }), /deflate/);
  });

  it("returns a copy that does not alias the response buffer", async () => {
    const zip = buildZip(FIT, { method: 0 });
    const { client } = setup([tokenOk(), zipRes(zip)]);
    const out = await client.downloadActivityFit("1");
    expect(out.buffer).not.toBe(zip.buffer);
  });
});
