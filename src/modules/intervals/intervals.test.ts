import { describe, expect, it } from "vitest";
import { callOf, event, input, reply, setup } from "../../../test/intervals-helpers.js";
import { IntervalsResponseError, loadIntervalsConfig } from "./index.js";

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
});

describe("createWorkout", () => {
  it("maps the response to an IntervalsEvent", async () => {
    const { client } = setup([reply(200, event)]);
    await expect(client.createWorkout(input)).resolves.toEqual({
      id: 7,
      externalId: "wristplan-x-1",
      startDateLocal: "2026-01-02T00:00:00",
      pushErrors: null,
    });
  });

  it("rejects non-JSON and empty bodies", async () => {
    const { client } = setup([reply(200, "<html>"), reply(200, "")]);
    await expect(client.createWorkout(input)).rejects.toBeInstanceOf(IntervalsResponseError);
    await expect(client.createWorkout(input)).rejects.toBeInstanceOf(IntervalsResponseError);
  });
});

describe("rescheduleWorkout", () => {
  it("returns the updated event after GET then PUT", async () => {
    const { client, fetchMock } = setup([
      reply(200, event),
      reply(200, { ...event, start_date_local: "2026-02-03T00:00:00" }),
    ]);
    const result = await client.rescheduleWorkout(7, "2026-02-03");
    expect(result.startDateLocal).toBe("2026-02-03T00:00:00");
    expect(callOf(fetchMock, 1).body).toEqual({
      ...event,
      start_date_local: "2026-02-03T00:00:00",
    });
  });
});
