import { describe, expect, it, vi } from "vitest";
import { event, input, reply, setup, setupOwnedDelete } from "../../../test/intervals-helpers.js";
import { createIntervalsClient, IntervalsValidationError } from "./index.js";

const badDates = [
  "2026-02-30",
  "2026-02-29",
  "2026-13-01",
  "2026-00-10",
  "2026-01-00",
  "2026-04-31",
  "2026-1-1",
  "2026-01-1",
  "",
  " 2026-01-02",
  "2026-01-02 ",
  "2026-01-02\n",
  "2026-01-02T00:00:00",
  "20260102",
  "２０２６-01-02",
  "nope",
];
const goodDates = ["2026-01-02", "2028-02-29", "2026-12-31", "2026-04-30"];
const badIds = [
  0,
  -1,
  Number.NaN,
  1.5,
  Number.POSITIVE_INFINITY,
  2 ** 53,
  Number.MAX_SAFE_INTEGER + 2,
];

describe("date validation", () => {
  it.each(badDates)("create and reschedule reject %j without calling the network", async (date) => {
    const { client, fetchMock } = setup();
    await expect(client.createWorkout({ ...input, date })).rejects.toBeInstanceOf(
      IntervalsValidationError,
    );
    await expect(client.rescheduleWorkout(7, date)).rejects.toBeInstanceOf(
      IntervalsValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(goodDates)("create accepts real calendar date %s", async (date) => {
    const { client } = setup([reply(200, { id: 1, start_date_local: `${date}T00:00:00` })]);
    await expect(client.createWorkout({ ...input, date })).resolves.toMatchObject({ id: 1 });
  });
});

describe("eventId validation", () => {
  it.each(badIds)("reschedule and delete reject %s without calling the network", async (id) => {
    const { client, fetchMock } = setup();
    await expect(client.rescheduleWorkout(id, "2026-01-02")).rejects.toBeInstanceOf(
      IntervalsValidationError,
    );
    await expect(client.deleteWorkout(id)).rejects.toBeInstanceOf(IntervalsValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the largest safe integer", async () => {
    const { client, fetchMock } = setupOwnedDelete(reply(204, ""), Number.MAX_SAFE_INTEGER);
    await client.deleteWorkout(Number.MAX_SAFE_INTEGER);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/events\/9007199254740991$/);
  });
});

describe("externalId validation", () => {
  it("rejects an empty externalId without calling the network", async () => {
    const { client, fetchMock } = setup();
    await expect(client.createWorkout({ ...input, externalId: "" })).rejects.toBeInstanceOf(
      IntervalsValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("athleteId handling", () => {
  it.each(["0", "i12345", "a_b-C"])("accepts athleteId %j", async (athleteId) => {
    const { client, fetchMock } = setupOwnedDelete(reply(204, ""), 3, athleteId);
    await client.deleteWorkout(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://intervals.icu/api/v1/athlete/${athleteId}/events/3`,
    );
  });

  it.each(["", ".", "..", "a b", "a/b", "a?b#c", "é"])(
    "rejects athleteId %j at construction",
    (athleteId) => {
      expect(() => setup([], athleteId)).toThrow(IntervalsValidationError);
    },
  );
});

describe("default fetch", () => {
  it("uses the global fetch when none is injected", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply(200, { ...event, id: 1 }))
      .mockResolvedValueOnce(reply(204, ""));
    vi.stubGlobal("fetch", spy);
    try {
      await createIntervalsClient({ apiKey: "k", athleteId: "0" }).deleteWorkout(1);
      expect(String(spy.mock.calls[0]?.[0])).toBe(
        "https://intervals.icu/api/v1/athlete/0/events/1",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("apiKey handling", () => {
  it.each(["", "   "])("rejects apiKey %j at construction", (apiKey) => {
    expect(() => createIntervalsClient({ apiKey, athleteId: "0" })).toThrow(
      IntervalsValidationError,
    );
  });
});
