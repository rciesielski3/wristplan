import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  BASIC,
  callOf,
  event,
  input,
  KEY,
  reply,
  setup,
  TOKEN,
} from "../../../test/intervals-helpers.js";
import {
  createIntervalsClient,
  IntervalsApiError,
  IntervalsForeignEventError,
  IntervalsNotFoundError,
  IntervalsResponseError,
  IntervalsValidationError,
  isOwnedEvent,
  OWNED_EXTERNAL_ID_PREFIX,
} from "./index.js";

const foreign = [
  { name: "foreign external_id", ext: "abc" },
  { name: "null external_id", ext: null },
  { name: "prefix without leading match", ext: "x-wristplan-1" },
];

describe("isOwnedEvent", () => {
  it.each([
    [`${OWNED_EXTERNAL_ID_PREFIX}m1`, true],
    ["abc", false],
    ["", false],
    [null, false],
  ])("externalId %j -> %s", (externalId, expected) => {
    expect(isOwnedEvent({ externalId })).toBe(expected);
  });

  it("treats an absent external_id as not owned", async () => {
    const { external_id: _omit, ...noExt } = event;
    const { client, fetchMock } = setup([reply(200, noExt)]);
    await expect(client.deleteWorkout(7)).rejects.toBeInstanceOf(IntervalsForeignEventError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createWorkout prefix", () => {
  it.each(["x-1", "Wristplan-1", " wristplan-1"])(
    "rejects externalId %j without calling the network",
    async (externalId) => {
      const { client, fetchMock } = setup();
      await expect(client.createWorkout({ ...input, externalId })).rejects.toBeInstanceOf(
        IntervalsValidationError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("deleteWorkout guard", () => {
  it("owned event: GET then DELETE, in that order", async () => {
    const { client, fetchMock } = setup([reply(200, event), reply(204, "")]);
    await client.deleteWorkout(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callOf(fetchMock, 0).method).toBe("GET");
    expect(callOf(fetchMock, 1).method).toBe("DELETE");
  });

  it.each(foreign)("$name: throws and never sends DELETE", async ({ ext }) => {
    const { client, fetchMock } = setup([reply(200, { ...event, external_id: ext })]);
    const err = await client.deleteWorkout(7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsForeignEventError);
    expect((err as IntervalsForeignEventError).message).toBe(
      "intervals.icu event 7 was not created by wristplan",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callOf(fetchMock, 0).method).toBe("GET");
  });

  it.each(foreign)("$name with allowForeign proceeds to DELETE", async ({ ext }) => {
    const { client, fetchMock } = setup([
      reply(200, { ...event, external_id: ext }),
      reply(204, ""),
    ]);
    await client.deleteWorkout(7, { allowForeign: true });
    expect(callOf(fetchMock, fetchMock.mock.calls.length - 1).method).toBe("DELETE");
  });

  it("allowForeign false or omitted still guards", async () => {
    const { client, fetchMock } = setup([reply(200, { ...event, external_id: "abc" })]);
    await expect(client.deleteWorkout(7, {})).rejects.toBeInstanceOf(IntervalsForeignEventError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("GET 404 is IntervalsNotFoundError and no DELETE is sent", async () => {
    const { client, fetchMock } = setup([reply(404, `gone ${KEY}`)]);
    const err = await client.deleteWorkout(7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsNotFoundError);
    expect(err).toMatchObject({ status: 404, method: "GET" });
    expect(String(err)).not.toContain(KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("foreign error and body never leak the key or event body", async () => {
    const { client } = setup([reply(200, { ...event, external_id: "abc", name: KEY })]);
    const err = await client.deleteWorkout(7).catch((e: unknown) => e);
    expect(String(err)).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
  });
});

describe("rescheduleWorkout guard", () => {
  it.each(foreign)("$name: throws and never sends PUT", async ({ ext }) => {
    const { client, fetchMock } = setup([reply(200, { ...event, external_id: ext })]);
    await expect(client.rescheduleWorkout(7, "2026-02-03")).rejects.toBeInstanceOf(
      IntervalsForeignEventError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callOf(fetchMock, 0).method).toBe("GET");
  });

  it("owned event: exactly one GET then one PUT", async () => {
    const { client, fetchMock } = setup([reply(200, event), reply(200, event)]);
    await client.rescheduleWorkout(7, "2026-02-03");
    expect(fetchMock.mock.calls.map((_, i) => callOf(fetchMock, i).method)).toEqual(["GET", "PUT"]);
  });
});

const methods = (fetchMock: ReturnType<typeof setup>["fetchMock"]) =>
  fetchMock.mock.calls.map((_, i) => callOf(fetchMock, i).method);

const ownedIds = ["wristplan-x", `wristplan-${"a".repeat(10_000)}`, "wristplan-\u00e9"];
const lookalikeIds = [
  "",
  "wristplan",
  "wristplan-",
  "WRISTPLAN-x",
  "Wristplan-x",
  " wristplan-x",
  "\ufeffwristplan-x",
  "xwristplan-x",
  "wristplan_x",
  "wristplan\u2013x",
  "wristplan\u200b-x",
  "\uff57ristplan-x",
  "wr\u0456stplan-x",
  "wristplan\u2010x",
  "x".repeat(10_000),
];
const nonStringIds: [string, unknown][] = [
  ["number", 5],
  ["boolean", true],
  ["object", { startsWith: "wristplan-" }],
  ["array", ["wristplan-x"]],
];

describe("external_id edge values", () => {
  it.each(ownedIds.map((e) => [e.slice(0, 20), e]))(
    "owned %j: GET then DELETE",
    async (_n, ext) => {
      const { client, fetchMock } = setup([
        reply(200, { ...event, external_id: ext }),
        reply(204, ""),
      ]);
      await client.deleteWorkout(7);
      expect(methods(fetchMock)).toEqual(["GET", "DELETE"]);
    },
  );

  it.each(lookalikeIds.map((e) => [e.slice(0, 20), e]))(
    "lookalike %j is foreign for delete and reschedule",
    async (_n, ext) => {
      const del = setup([reply(200, { ...event, external_id: ext }), reply(204, "")]);
      await expect(del.client.deleteWorkout(7)).rejects.toBeInstanceOf(IntervalsForeignEventError);
      expect(methods(del.fetchMock)).toEqual(["GET"]);
      const mv = setup([reply(200, { ...event, external_id: ext }), reply(200, event)]);
      await expect(mv.client.rescheduleWorkout(7, "2026-02-03")).rejects.toBeInstanceOf(
        IntervalsForeignEventError,
      );
      expect(methods(mv.fetchMock)).toEqual(["GET"]);
    },
  );

  it.each(lookalikeIds.map((e) => [e.slice(0, 20), e]))(
    "createWorkout rejects externalId %j without a request",
    async (_n, ext) => {
      const { client, fetchMock } = setup();
      await expect(client.createWorkout({ ...input, externalId: ext })).rejects.toBeInstanceOf(
        IntervalsValidationError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(nonStringIds)(
    "non-string %s external_id is a response error and never mutates",
    async (_n, ext) => {
      const del = setup([reply(200, { ...event, external_id: ext }), reply(204, "")]);
      await expect(del.client.deleteWorkout(7)).rejects.toBeInstanceOf(IntervalsResponseError);
      expect(methods(del.fetchMock)).toEqual(["GET"]);
      const mv = setup([reply(200, { ...event, external_id: ext }), reply(200, event)]);
      await expect(mv.client.rescheduleWorkout(7, "2026-02-03")).rejects.toBeInstanceOf(
        IntervalsResponseError,
      );
      expect(methods(mv.fetchMock)).toEqual(["GET"]);
    },
  );

  it("empty-string external_id is foreign", async () => {
    const { client, fetchMock } = setup([reply(200, { ...event, external_id: "" })]);
    await expect(client.deleteWorkout(7)).rejects.toBeInstanceOf(IntervalsForeignEventError);
    expect(methods(fetchMock)).toEqual(["GET"]);
  });
});

describe("guard GET failures never proceed to a mutation", () => {
  const failures: [string, () => ReturnType<typeof setup>][] = [
    ...[401, 403, 404, 429, 500, 503].map((status): [string, () => ReturnType<typeof setup>] => [
      `HTTP ${status}`,
      () => setup([reply(status, "x"), reply(204, "")]),
    ]),
    ["malformed json", () => setup([reply(200, "{nope"), reply(204, "")])],
    ["empty 200 body", () => setup([reply(200, ""), reply(204, "")])],
    ["array body", () => setup([reply(200, [event]), reply(204, "")])],
    ["null body", () => setup([reply(200, "null"), reply(204, "")])],
    [
      "missing id",
      () => setup([reply(200, { external_id: "wristplan-x", start_date_local: "d" })]),
    ],
    ["missing start_date_local", () => setup([reply(200, { id: 7, external_id: "wristplan-x" })])],
    ["string id", () => setup([reply(200, { ...event, id: "7" })])],
    [
      "network error",
      () => {
        const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
        return {
          client: createIntervalsClient({ apiKey: KEY, athleteId: "0", fetch: fetchMock }),
          fetchMock,
        };
      },
    ],
    [
      "timeout",
      () => {
        const fetchMock = vi
          .fn<typeof fetch>()
          .mockRejectedValue(new DOMException("timed out", "TimeoutError"));
        return {
          client: createIntervalsClient({ apiKey: KEY, athleteId: "0", fetch: fetchMock }),
          fetchMock,
        };
      },
    ],
    [
      "body read failure",
      () =>
        setup([
          {
            ok: true,
            status: 200,
            text: () => Promise.reject(new Error("reset")),
          } as unknown as Response,
        ]),
    ],
  ];

  it.each(failures)("%s on delete: rejects after one GET and no DELETE", async (_n, make) => {
    const { client, fetchMock } = make();
    await expect(client.deleteWorkout(7)).rejects.toBeInstanceOf(Error);
    expect(methods(fetchMock)).toEqual(["GET"]);
  });

  it.each(failures)("%s on reschedule: rejects after one GET and no PUT", async (_n, make) => {
    const { client, fetchMock } = make();
    await expect(client.rescheduleWorkout(7, "2026-02-03")).rejects.toBeInstanceOf(Error);
    expect(methods(fetchMock)).toEqual(["GET"]);
  });

  it("GET 401 and 403 are api errors for GET, not foreign errors", async () => {
    for (const status of [401, 403]) {
      const { client } = setup([reply(status, "")]);
      const err = await client.deleteWorkout(7).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IntervalsApiError);
      expect(err).not.toBeInstanceOf(IntervalsForeignEventError);
      expect(err).toMatchObject({ status, method: "GET" });
    }
  });
});

describe("allowForeign must be exactly boolean true", () => {
  it.each<[string, unknown]>([
    ["string true", "true"],
    ["number 1", 1],
    ["empty object", {}],
    ["empty array", []],
    ["non-empty string", "yes"],
    ["false", false],
    ["undefined", undefined],
    ["null", null],
    ["boxed true", Object(true)],
  ])("%s does not bypass the guard", async (_n, flag) => {
    const { client, fetchMock } = setup([
      reply(200, { ...event, external_id: "abc" }),
      reply(204, ""),
    ]);
    const err = await client
      .deleteWorkout(7, { allowForeign: flag } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsForeignEventError);
    expect(methods(fetchMock)).toEqual(["GET"]);
  });

  it.each<[string, unknown]>([
    ["undefined options", undefined],
    ["null options", null],
    ["empty options", {}],
    ["unrelated keys", { allowforeign: true, ALLOWFOREIGN: true, force: true }],
  ])("%s keeps the guard on", async (_n, opts) => {
    const { client, fetchMock } = setup([reply(200, { ...event, external_id: "abc" })]);
    await expect(client.deleteWorkout(7, opts as never)).rejects.toBeInstanceOf(
      IntervalsForeignEventError,
    );
    expect(methods(fetchMock)).toEqual(["GET"]);
  });

  it("allowForeign: true sends only DELETE, without a GET", async () => {
    const { client, fetchMock } = setup([reply(204, "")]);
    await client.deleteWorkout(7, { allowForeign: true });
    expect(methods(fetchMock)).toEqual(["DELETE"]);
  });

  it("allowForeign: true surfaces DELETE failure as an api error", async () => {
    const { client, fetchMock } = setup([reply(500, "x")]);
    await expect(client.deleteWorkout(7, { allowForeign: true })).rejects.toMatchObject({
      status: 500,
      method: "DELETE",
    });
    expect(methods(fetchMock)).toEqual(["DELETE"]);
  });

  it("allowForeign: true still validates the event id before any request", async () => {
    const { client, fetchMock } = setup();
    await expect(client.deleteWorkout(0, { allowForeign: true })).rejects.toBeInstanceOf(
      IntervalsValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allowForeign does not influence reschedule", async () => {
    const { client, fetchMock } = setup([reply(200, { ...event, external_id: "abc" })]);
    await expect(
      (client.rescheduleWorkout as (...a: unknown[]) => Promise<unknown>)(7, "2026-02-03", {
        allowForeign: true,
      }),
    ).rejects.toBeInstanceOf(IntervalsForeignEventError);
    expect(methods(fetchMock)).toEqual(["GET"]);
  });

  it("an inherited allowForeign property does not bypass the guard", async () => {
    const { client, fetchMock } = setup([
      reply(200, { ...event, external_id: "abc" }),
      reply(204, ""),
    ]);
    const opts = Object.create({ allowForeign: true });
    await expect(client.deleteWorkout(7, opts)).rejects.toBeInstanceOf(IntervalsForeignEventError);
    expect(methods(fetchMock)).toEqual(["GET"]);
  });
});

describe("guard hardening", () => {
  it("polluted Object.prototype.allowForeign does not bypass the guard", async () => {
    const { client, fetchMock } = setup([reply(200, { ...event, external_id: "abc" })]);
    Object.defineProperty(Object.prototype, "allowForeign", {
      value: true,
      configurable: true,
    });
    try {
      await expect(client.deleteWorkout(7, {})).rejects.toBeInstanceOf(IntervalsForeignEventError);
    } finally {
      delete (Object.prototype as Record<string, unknown>).allowForeign;
    }
    expect(methods(fetchMock)).toEqual(["GET"]);
  });

  it("null options are treated as no options", async () => {
    const { client, fetchMock } = setup([reply(200, { ...event, external_id: "abc" })]);
    await expect(client.deleteWorkout(7, null as never)).rejects.toBeInstanceOf(
      IntervalsForeignEventError,
    );
    expect(methods(fetchMock)).toEqual(["GET"]);
  });

  it.each([5, null, undefined, {}, ["wristplan-x"]])(
    "createWorkout rejects non-string externalId %j with a validation error",
    async (externalId) => {
      const { client, fetchMock } = setup();
      await expect(
        client.createWorkout({ ...input, externalId: externalId as never }),
      ).rejects.toBeInstanceOf(IntervalsValidationError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("the bare prefix is not owned", () => {
    expect(isOwnedEvent({ externalId: OWNED_EXTERNAL_ID_PREFIX })).toBe(false);
  });

  it("delete and reschedule reject a GET body whose id differs from the request", async () => {
    const del = setup([reply(200, { ...event, id: 8 }), reply(204, "")]);
    await expect(del.client.deleteWorkout(7)).rejects.toBeInstanceOf(IntervalsResponseError);
    expect(methods(del.fetchMock)).toEqual(["GET"]);
    const mv = setup([reply(200, { ...event, id: 8 }), reply(200, event)]);
    await expect(mv.client.rescheduleWorkout(7, "2026-02-03")).rejects.toBeInstanceOf(
      IntervalsResponseError,
    );
    expect(methods(mv.fetchMock)).toEqual(["GET"]);
  });
});

describe("guard under concurrency", () => {
  it("only the owned event of two concurrent deletes is deleted", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const id = String(url).split("/").pop();
      if (init?.method === "GET") {
        return reply(200, {
          ...event,
          id: Number(id),
          external_id: id === "7" ? "wristplan-a" : "abc",
        });
      }
      return reply(204, "");
    });
    const client = createIntervalsClient({ apiKey: KEY, athleteId: "0", fetch: fetchMock });
    const results = await Promise.allSettled([client.deleteWorkout(7), client.deleteWorkout(8)]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected" });
    const sent = fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u).split("/").pop()}`);
    expect(sent.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE 7"]);
    expect(sent.filter((c) => c.startsWith("GET")).sort()).toEqual(["GET 7", "GET 8"]);
  });

  it("concurrent reschedules of owned and foreign events only PUT the owned one", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const id = Number(String(url).split("/").pop());
      return reply(200, { ...event, id, external_id: id === 7 ? "wristplan-a" : "abc" });
    });
    const client = createIntervalsClient({ apiKey: KEY, athleteId: "0", fetch: fetchMock });
    const results = await Promise.allSettled([
      client.rescheduleWorkout(7, "2026-02-03"),
      client.rescheduleWorkout(8, "2026-02-03"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const puts = fetchMock.mock.calls
      .filter(([, i]) => i?.method === "PUT")
      .map(([u]) => String(u));
    expect(puts).toEqual([expect.stringMatching(/\/events\/7$/)]);
  });

  it("repeated delete of the same owned event sends a GET before every DELETE", async () => {
    const { client, fetchMock } = setup([reply(200, event), reply(204, ""), reply(404, "gone")]);
    await client.deleteWorkout(7);
    await expect(client.deleteWorkout(7)).rejects.toBeInstanceOf(IntervalsNotFoundError);
    expect(methods(fetchMock)).toEqual(["GET", "DELETE", "GET"]);
  });
});

describe("guard error hygiene", () => {
  const surfaces = (e: unknown) => [
    String(e),
    JSON.stringify(e),
    inspect(e, { depth: 10, showHidden: true }),
    e instanceof Error ? (e.stack ?? "") : "",
  ];

  it("foreign error mentions only the event id even when event fields hold secrets", async () => {
    const hostile = { ...event, external_id: KEY, name: `${BASIC} ${TOKEN}`, description: KEY };
    const del = setup([reply(200, hostile)]);
    const mv = setup([reply(200, hostile)]);
    const errs = [
      await del.client.deleteWorkout(7).catch((e: unknown) => e),
      await mv.client.rescheduleWorkout(7, "2026-02-03").catch((e: unknown) => e),
    ];
    for (const err of errs) {
      expect(err).toBeInstanceOf(IntervalsForeignEventError);
      expect((err as Error).message).toBe("intervals.icu event 7 was not created by wristplan");
      expect(Object.keys(err as object).sort()).toEqual(["eventId", "name"]);
      for (const text of surfaces(err)) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain("Basic ");
      }
    }
  });

  it("api errors from the guard GET are redacted on every surface", async () => {
    const { client } = setup([reply(500, `${KEY} ${BASIC} ${TOKEN}`)]);
    const err = await client.deleteWorkout(7).catch((e: unknown) => e);
    for (const text of surfaces(err)) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(TOKEN);
    }
  });

  it("the guard GET carries the credentials in the header only, not the URL", async () => {
    const { client, fetchMock } = setup([reply(200, event), reply(204, "")]);
    await client.deleteWorkout(7);
    for (const i of [0, 1]) {
      const c = callOf(fetchMock, i);
      expect(c.url).toBe("https://intervals.icu/api/v1/athlete/0/events/7");
      expect(c.url).not.toContain(KEY);
      expect(c.headers.get("authorization")).toBe(BASIC);
    }
  });
});
