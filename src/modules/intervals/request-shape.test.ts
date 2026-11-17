import { describe, expect, it, vi } from "vitest";
import {
  BASE,
  BASIC,
  callOf,
  event,
  input,
  reply,
  setup,
  setupOwnedDelete,
} from "../../../test/intervals-helpers.js";
import { createIntervalsClient } from "./index.js";

describe("request shape", () => {
  it("create sends POST with upsert query, auth, json content type and exact body", async () => {
    const { client, fetchMock } = setup([reply(200, event)]);
    await client.createWorkout(input);
    const c = callOf(fetchMock);
    expect(c.method).toBe("POST");
    expect(c.url).toBe(`${BASE}/athlete/0/events?upsertOnUid=true`);
    expect(c.headers.get("authorization")).toBe(BASIC);
    expect(c.headers.get("content-type")).toBe("application/json");
    expect(c.body).toEqual({
      category: "WORKOUT",
      type: "Run",
      name: "Tempo",
      start_date_local: "2026-01-02T00:00:00",
      target: "HR",
      description: "- 10m Z1 HR",
      external_id: "wristplan-x-1",
    });
  });

  it.each(["HR", "PACE", "POWER", "AUTO"] as const)("passes target %s through", async (target) => {
    const { client, fetchMock } = setup([reply(200, event)]);
    await client.createWorkout({ ...input, target });
    expect(callOf(fetchMock).body.target).toBe(target);
  });

  it("repeated create with the same externalId always requests upsert with identical body", async () => {
    const { client, fetchMock } = setup([reply(200, event), reply(200, event)]);
    const first = await client.createWorkout(input);
    const second = await client.createWorkout(input);
    expect(second).toEqual(first);
    const [a, b] = [callOf(fetchMock, 0), callOf(fetchMock, 1)];
    expect(a.url).toContain("upsertOnUid=true");
    expect(b.url).toBe(a.url);
    expect(b.rawBody).toBe(a.rawBody);
    expect(b.body.external_id).toBe("wristplan-x-1");
  });

  it("reschedule issues GET without body then PUT with json content type, both authorised", async () => {
    const { client, fetchMock } = setup([reply(200, event), reply(200, event)]);
    await client.rescheduleWorkout(7, "2026-02-03");
    const [get, put] = [callOf(fetchMock, 0), callOf(fetchMock, 1)];
    expect(get.method).toBe("GET");
    expect(get.url).toBe(`${BASE}/athlete/0/events/7`);
    expect(get.rawBody).toBeUndefined();
    expect(put.method).toBe("PUT");
    expect(put.url).toBe(`${BASE}/athlete/0/events/7`);
    expect(put.headers.get("content-type")).toBe("application/json");
    for (const c of [get, put]) expect(c.headers.get("authorization")).toBe(BASIC);
  });

  it("reschedule PUT preserves every field of the fetched event and changes only start_date_local", async () => {
    const full = {
      ...event,
      category: "WORKOUT",
      type: "Run",
      description: "- 10m Z1 HR",
      target: "HR",
      moving_time: 3600,
      icu_training_load: 42.5,
      tags: ["a", "b"],
      nested: { zones: [1, 2, { z: null }] },
      unicode: "żółć",
      empty: "",
      nothing: null,
      unknown_future_field: { x: 1 },
    };
    const { client, fetchMock } = setup([reply(200, full), reply(200, full)]);
    await client.rescheduleWorkout(7, "2027-12-31");
    expect(callOf(fetchMock, 1).body).toEqual({ ...full, start_date_local: "2027-12-31T00:00:00" });
  });

  it("delete sends an authorised, body-less GET then DELETE, credentials only in the header", async () => {
    const { client, fetchMock } = setupOwnedDelete(reply(204, ""));
    await client.deleteWorkout(7);
    const [get, del] = [callOf(fetchMock, 0), callOf(fetchMock, 1)];
    expect([get.method, del.method]).toEqual(["GET", "DELETE"]);
    for (const c of [get, del]) {
      expect(c.url).toBe(`${BASE}/athlete/0/events/7`);
      expect(c.rawBody).toBeUndefined();
      expect(c.headers.get("content-type")).toBeNull();
      expect(c.headers.get("authorization")).toBe(BASIC);
    }
  });

  it("honours a custom baseUrl", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply(204, ""));
    await createIntervalsClient({
      apiKey: "k",
      athleteId: "i9",
      fetch: fetchMock,
      baseUrl: "http://localhost:1/api",
    }).deleteWorkout(3, { allowForeign: true });
    expect(callOf(fetchMock).url).toBe("http://localhost:1/api/athlete/i9/events/3");
  });
});
