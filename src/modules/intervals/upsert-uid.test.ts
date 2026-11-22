import { describe, expect, it } from "vitest";
import { createFakeIntervalsServer } from "../../../test/fake-intervals-server";
import { input } from "../../../test/intervals-helpers";

describe("upsert by uid through the fake server", () => {
  it("same externalId on different dates yields one event, same id, date moved", async () => {
    const server = createFakeIntervalsServer();
    const first = await server.client.createWorkout(input);
    const second = await server.client.createWorkout({ ...input, date: "2026-01-09" });
    expect(second.id).toBe(first.id);
    expect(server.events.size).toBe(1);
    expect(server.dateOf(first.id)).toBe("2026-01-09");
  });

  it("a body without uid does not dedupe on external_id and gets a generated uid", async () => {
    const server = createFakeIntervalsServer();
    const post = () =>
      server.fetch("https://intervals.icu/api/v1/athlete/0/events?upsertOnUid=true", {
        method: "POST",
        body: JSON.stringify({
          external_id: "wristplan-x-1",
          start_date_local: "2026-01-02T00:00:00",
        }),
      });
    const [a, b] = await Promise.all([post(), post()]);
    const [ea, eb] = (await Promise.all([a.json(), b.json()])) as { id: number; uid: string }[];
    expect(server.events.size).toBe(2);
    expect(ea?.id).not.toBe(eb?.id);
    expect(ea?.uid).toMatch(/\S/);
    expect(ea?.uid).not.toBe(eb?.uid);
  });
});

describe("upsert by uid and foreign events", () => {
  it("an owned create never matches or overwrites a seeded foreign event", async () => {
    const server = createFakeIntervalsServer();
    const foreignId = server.seedForeign("2026-01-02");
    const created = await server.client.createWorkout(input);
    expect(created.id).not.toBe(foreignId);
    expect(server.events.size).toBe(2);
    expect(server.events.get(foreignId)).toMatchObject({
      uid: `seed-${foreignId}`,
      external_id: null,
      start_date_local: "2026-01-02T00:00:00",
    });
  });

  it("an event sharing only external_id (different uid) is left untouched by the upsert", async () => {
    const server = createFakeIntervalsServer();
    server.events.set(99, {
      id: 99,
      uid: "other-uid",
      external_id: input.externalId,
      start_date_local: "2026-01-02T00:00:00",
      name: "legacy",
    });
    const created = await server.client.createWorkout({ ...input, date: "2026-01-09" });
    expect(created.id).not.toBe(99);
    expect(server.events.size).toBe(2);
    expect(server.events.get(99)).toMatchObject({
      name: "legacy",
      start_date_local: "2026-01-02T00:00:00",
    });
  });

  it("reschedule keeps the uid, and a later create with the same externalId follows the moved event", async () => {
    const server = createFakeIntervalsServer();
    const created = await server.client.createWorkout(input);
    await server.client.rescheduleWorkout(created.id, "2026-01-20");
    expect(server.events.get(created.id)?.uid).toBe(input.externalId);
    const again = await server.client.createWorkout(input);
    expect(again.id).toBe(created.id);
    expect(server.events.size).toBe(1);
  });
});
