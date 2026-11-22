import { describe, expect, it } from "vitest";
import { createFakeIntervalsServer } from "../../../test/fake-intervals-server";
import { input } from "../../../test/intervals-helpers";

const WINDOW = { oldest: "2025-01-01", newest: "2027-12-31" };

describe("fake server matches the live behaviour", () => {
  it("ignores a client uid and creates a new event on every POST, even with upsertOnUid", async () => {
    const server = createFakeIntervalsServer();
    const post = () =>
      server.fetch("https://intervals.icu/api/v1/athlete/0/events?upsertOnUid=true", {
        method: "POST",
        body: JSON.stringify({
          uid: "client-chosen",
          external_id: "wristplan-x-1",
          start_date_local: "2026-01-02T00:00:00",
        }),
      });
    const [a, b] = (await Promise.all([post(), post()]).then((rs) =>
      Promise.all(rs.map((r) => r.json())),
    )) as { id: number; uid: string }[];
    expect(server.events.size).toBe(2);
    expect(a?.id).not.toBe(b?.id);
    expect(a?.uid).not.toBe("client-chosen");
    expect(a?.uid).not.toBe(b?.uid);
  });

  it("list filters by start date and exposes external_id and uid", async () => {
    const server = createFakeIntervalsServer();
    await server.client.createWorkout(input);
    const res = await server.fetch(
      "https://intervals.icu/api/v1/athlete/0/events?oldest=2026-01-02&newest=2026-01-02",
    );
    expect(await res.json()).toMatchObject([
      { external_id: input.externalId, uid: expect.stringMatching(/\S/) },
    ]);
    const empty = await server.fetch(
      "https://intervals.icu/api/v1/athlete/0/events?oldest=2026-01-03&newest=2026-01-09",
    );
    expect(await empty.json()).toEqual([]);
  });

  it("list without a window is rejected", async () => {
    const server = createFakeIntervalsServer();
    const res = await server.fetch("https://intervals.icu/api/v1/athlete/0/events");
    expect(res.status).toBe(422);
  });
});

describe("findWorkoutByExternalId through the fake server", () => {
  it("finds the created event and returns null when none matches", async () => {
    const server = createFakeIntervalsServer();
    expect(await server.client.findWorkoutByExternalId(input.externalId, WINDOW)).toBeNull();
    const created = await server.client.createWorkout(input);
    const found = await server.client.findWorkoutByExternalId(input.externalId, WINDOW);
    expect(found?.id).toBe(created.id);
  });

  it("does not find an event outside the window", async () => {
    const server = createFakeIntervalsServer();
    await server.client.createWorkout(input);
    const found = await server.client.findWorkoutByExternalId(input.externalId, {
      oldest: "2026-02-01",
      newest: "2026-02-28",
    });
    expect(found).toBeNull();
  });

  it("never matches a foreign event", async () => {
    const server = createFakeIntervalsServer();
    server.seedForeign("2026-01-02");
    expect(await server.client.findWorkoutByExternalId(input.externalId, WINDOW)).toBeNull();
  });

  it("rejects duplicate external_id matches", async () => {
    const server = createFakeIntervalsServer();
    await server.client.createWorkout(input);
    await server.client.createWorkout(input);
    await expect(
      server.client.findWorkoutByExternalId(input.externalId, WINDOW),
    ).rejects.toMatchObject({ name: "IntervalsResponseError" });
  });
});
