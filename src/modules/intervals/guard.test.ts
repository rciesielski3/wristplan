import { describe, expect, it } from "vitest";
import {
  event,
  input,
  KEY,
  methodsOf,
  reply,
  setup,
  setupOwnedDelete,
} from "../../../test/intervals-helpers";
import {
  IntervalsForeignEventError,
  IntervalsNotFoundError,
  IntervalsResponseError,
  IntervalsValidationError,
  isOwnedEvent,
  OWNED_EXTERNAL_ID_PREFIX,
} from "./index";

const foreign: { name: string; ext: string | null | undefined }[] = [
  { name: "foreign external_id", ext: "abc" },
  { name: "null external_id", ext: null },
  { name: "absent external_id", ext: undefined },
  { name: "prefix without leading match", ext: "x-wristplan-1" },
];

const lookalikes = ["WRISTPLAN-x", "Wristplan-x", " wristplan-x", "wristplan", "wristplan_x"];

describe("isOwnedEvent", () => {
  it.each([
    [`${OWNED_EXTERNAL_ID_PREFIX}m1`, true],
    ["wristplan-é", true],
    ["abc", false],
    [null, false],
    ["", false],
    [OWNED_EXTERNAL_ID_PREFIX, false],
    ...lookalikes.map((e): [string, boolean] => [e, false]),
  ])("externalId %j -> %s", (externalId, expected) => {
    expect(isOwnedEvent({ externalId })).toBe(expected);
  });

  it("treats an absent external_id as not owned", async () => {
    const { external_id: _omit, ...noExt } = event;
    const { client, fetchMock } = setup([reply(200, noExt)]);
    await expect(client.deleteWorkout(7)).rejects.toBeInstanceOf(IntervalsForeignEventError);
    expect(methodsOf(fetchMock)).toEqual(["GET"]);
  });
});

describe("createWorkout prefix", () => {
  it.each([...lookalikes, "x-1", "wristplan-", 5, ["wristplan-x"]])(
    "rejects externalId %j without calling the network",
    async (externalId) => {
      const { client, fetchMock } = setup();
      await expect(
        client.createWorkout({ ...input, externalId: externalId as string }),
      ).rejects.toBeInstanceOf(IntervalsValidationError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("deleteWorkout guard", () => {
  it("owned event: GET then DELETE, in that order", async () => {
    const { client, fetchMock } = setupOwnedDelete(reply(204, ""));
    await client.deleteWorkout(7);
    expect(methodsOf(fetchMock)).toEqual(["GET", "DELETE"]);
  });

  it.each(foreign)("$name: throws and never sends DELETE", async ({ ext }) => {
    const { client, fetchMock } = setup([
      reply(200, { ...event, external_id: ext }),
      reply(204, ""),
    ]);
    const err = await client.deleteWorkout(7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsForeignEventError);
    expect((err as Error).message).toBe("intervals.icu event 7 was not created by wristplan");
    expect(methodsOf(fetchMock)).toEqual(["GET"]);
  });

  it("GET 404 is IntervalsNotFoundError and no DELETE is sent", async () => {
    const { client, fetchMock } = setup([reply(404, `gone ${KEY}`), reply(204, "")]);
    const err = await client.deleteWorkout(7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsNotFoundError);
    expect(err).toMatchObject({ status: 404, method: "GET" });
    expect(methodsOf(fetchMock)).toEqual(["GET"]);
  });

  it("GET failure never proceeds to DELETE", async () => {
    const { client, fetchMock } = setup([reply(500, "x"), reply(204, "")]);
    await expect(client.deleteWorkout(7)).rejects.toMatchObject({ status: 500, method: "GET" });
    expect(methodsOf(fetchMock)).toEqual(["GET"]);
  });

  it("rejects a GET body whose id differs from the request", async () => {
    const { client, fetchMock } = setup([reply(200, { ...event, id: 8 }), reply(204, "")]);
    await expect(client.deleteWorkout(7)).rejects.toBeInstanceOf(IntervalsResponseError);
    expect(methodsOf(fetchMock)).toEqual(["GET"]);
  });

  it("non-string external_id is a response error and never deletes", async () => {
    const { client, fetchMock } = setup([reply(200, { ...event, external_id: 5 }), reply(204, "")]);
    await expect(client.deleteWorkout(7)).rejects.toBeInstanceOf(IntervalsResponseError);
    expect(methodsOf(fetchMock)).toEqual(["GET"]);
  });
});

describe("rescheduleWorkout guard", () => {
  it.each(foreign)("$name: throws and never sends PUT", async ({ ext }) => {
    const { client, fetchMock } = setup([
      reply(200, { ...event, external_id: ext }),
      reply(200, event),
    ]);
    await expect(client.rescheduleWorkout(7, "2026-02-03")).rejects.toBeInstanceOf(
      IntervalsForeignEventError,
    );
    expect(methodsOf(fetchMock)).toEqual(["GET"]);
  });

  it("owned event: exactly one GET then one PUT", async () => {
    const { client, fetchMock } = setup([reply(200, event), reply(200, event)]);
    await client.rescheduleWorkout(7, "2026-02-03");
    expect(methodsOf(fetchMock)).toEqual(["GET", "PUT"]);
  });

  it("malformed GET body never proceeds to PUT", async () => {
    const { client, fetchMock } = setup([reply(200, "{nope"), reply(200, event)]);
    await expect(client.rescheduleWorkout(7, "2026-02-03")).rejects.toBeInstanceOf(
      IntervalsResponseError,
    );
    expect(methodsOf(fetchMock)).toEqual(["GET"]);
  });

  it("rejects a GET body whose id differs from the request", async () => {
    const { client, fetchMock } = setup([reply(200, { ...event, id: 8 }), reply(200, event)]);
    await expect(client.rescheduleWorkout(7, "2026-02-03")).rejects.toBeInstanceOf(
      IntervalsResponseError,
    );
    expect(methodsOf(fetchMock)).toEqual(["GET"]);
  });

  it("allowForeign does not influence reschedule", async () => {
    const { client, fetchMock } = setup([reply(200, { ...event, external_id: "abc" })]);
    await expect(
      (client.rescheduleWorkout as (...a: unknown[]) => Promise<unknown>)(7, "2026-02-03", {
        allowForeign: true,
      }),
    ).rejects.toBeInstanceOf(IntervalsForeignEventError);
    expect(methodsOf(fetchMock)).toEqual(["GET"]);
  });
});

describe("allowForeign bypass", () => {
  it("true sends only DELETE, even for a foreign event", async () => {
    const { client, fetchMock } = setup([reply(204, "")]);
    await client.deleteWorkout(7, { allowForeign: true });
    expect(methodsOf(fetchMock)).toEqual(["DELETE"]);
  });

  it("true surfaces DELETE failure as an api error", async () => {
    const { client } = setup([reply(500, "x")]);
    await expect(client.deleteWorkout(7, { allowForeign: true })).rejects.toMatchObject({
      status: 500,
      method: "DELETE",
    });
  });

  it.each<[string, unknown]>([
    ["string true", { allowForeign: "true" }],
    ["number 1", { allowForeign: 1 }],
    ["empty object", { allowForeign: {} }],
    ["false", { allowForeign: false }],
    ["undefined", { allowForeign: undefined }],
    ["null", { allowForeign: null }],
    ["boxed true", { allowForeign: Object(true) }],
    ["undefined options", undefined],
    ["null options", null],
    ["empty options", {}],
    ["unrelated keys", { allowforeign: true, force: true }],
    ["inherited property", Object.create({ allowForeign: true })],
  ])("%s does not bypass the guard", async (_n, opts) => {
    const { client, fetchMock } = setup([
      reply(200, { ...event, external_id: "abc" }),
      reply(204, ""),
    ]);
    await expect(client.deleteWorkout(7, opts as never)).rejects.toBeInstanceOf(
      IntervalsForeignEventError,
    );
    expect(methodsOf(fetchMock)).toEqual(["GET"]);
  });

  it("polluted Object.prototype.allowForeign does not bypass the guard", async () => {
    const { client, fetchMock } = setup([reply(200, { ...event, external_id: "abc" })]);
    Object.defineProperty(Object.prototype, "allowForeign", { value: true, configurable: true });
    try {
      await expect(client.deleteWorkout(7, {})).rejects.toBeInstanceOf(IntervalsForeignEventError);
    } finally {
      delete (Object.prototype as Record<string, unknown>).allowForeign;
    }
    expect(methodsOf(fetchMock)).toEqual(["GET"]);
  });
});
