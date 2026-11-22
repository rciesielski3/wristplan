import { describe, expect, it, vi } from "vitest";
import { createFakeIntervalsServer } from "../../../test/fake-intervals-server";
import { createIntervalsClient } from "../intervals";
import { createIntervalsPublisher } from "./intervals-publisher";
import {
  PublisherAuthError,
  PublisherForeignEventError,
  PublisherNotFoundError,
  PublisherRateLimitError,
  PublisherRejectedError,
  PublisherTransientError,
  type PublishInput,
} from "./publisher";

const input: PublishInput = {
  externalId: "wristplan-a1",
  date: "2026-03-02",
  name: "Tempo",
  text: "Warmup\n- 10m Z1 HR",
  sport: "run",
  target: "pace",
};

const NOW = new Date("2026-03-01T10:00:00Z");

const setup = () => {
  const server = createFakeIntervalsServer();
  return { server, publisher: createIntervalsPublisher(server.client, { now: () => NOW }) };
};

describe("createIntervalsPublisher", () => {
  it("creates a Run workout carrying text, target and external id", async () => {
    const { server, publisher } = setup();
    const { remoteId } = await publisher.publish(input);
    const [, init] = server.fetch.mock.calls.find(([, i]) => i?.method === "POST") ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      type: "Run",
      target: "PACE",
      description: input.text,
      external_id: "wristplan-a1",
      start_date_local: "2026-03-02T00:00:00",
    });
    expect(server.events.get(Number(remoteId))?.name).toBe("Tempo");
  });

  it("reschedules an owned event", async () => {
    const { server, publisher } = setup();
    const { remoteId } = await publisher.publish(input);
    await publisher.reschedule(remoteId, "2026-03-09");
    expect(server.events.get(Number(remoteId))?.start_date_local).toBe("2026-03-09T00:00:00");
  });

  it("refuses to reschedule or delete a foreign event and never sends the write", async () => {
    const { server, publisher } = setup();
    const id = String(server.seedForeign("2026-03-02"));
    await expect(publisher.reschedule(id, "2026-03-09")).rejects.toBeInstanceOf(
      PublisherForeignEventError,
    );
    await expect(publisher.remove(id)).rejects.toBeInstanceOf(PublisherForeignEventError);
    const methods = server.fetch.mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods).toEqual(["GET", "GET"]);
    expect(server.events.has(Number(id))).toBe(true);
  });

  it.each([
    "0",
    "-1",
    "1.5",
    "abc",
    "",
    "99999999999999999999",
    "01",
    " 1",
    "1 ",
    "1e3",
    "0x10",
    "9007199254740993",
    "+1",
    "1\n",
  ])("treats malformed remote id %j as not found without calling the API", async (id) => {
    const { server, publisher } = setup();
    await expect(publisher.remove(id)).rejects.toBeInstanceOf(PublisherNotFoundError);
    await expect(publisher.reschedule(id, "2026-03-09")).rejects.toBeInstanceOf(
      PublisherNotFoundError,
    );
    expect(server.fetch).not.toHaveBeenCalled();
  });

  describe.each([
    [401, PublisherAuthError],
    [403, PublisherAuthError],
    [429, PublisherRateLimitError],
    [500, PublisherTransientError],
    [503, PublisherTransientError],
    [400, PublisherRejectedError],
    [422, PublisherRejectedError],
  ])("http %i", (status, expected) => {
    it(`maps to ${expected.name} with the status and no body detail`, async () => {
      const { server, publisher } = setup();
      server.respondWith(() => new Response("secret-body-detail", { status }));
      const error = await publisher.publish(input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(expected);
      expect((error as Error).message).not.toContain("secret-body-detail");
    });
  });

  it("looks the externalId up first, creates with upsertOnUid=false, then reschedules instead of creating", async () => {
    const { server, publisher } = setup();
    const a = await publisher.publish(input);
    const b = await publisher.publish({ ...input, date: "2026-03-03" });
    expect(b.remoteId).toBe(a.remoteId);
    expect(server.events.size).toBe(1);
    const calls = server.fetch.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${url}`);
    expect(calls[0]).toContain(
      "GET https://intervals.icu/api/v1/athlete/0/events?oldest=2025-02-28&newest=2028-03-01",
    );
    expect(calls[1]).toContain("POST ");
    expect(calls[1]).toContain("upsertOnUid=false");
    expect(calls.slice(2).map((c) => c.split(" ")[0])).toEqual(["GET", "GET", "PUT"]);
  });

  it("does not write when the found event is already on the requested date", async () => {
    const { server, publisher } = setup();
    await publisher.publish(input);
    server.fetch.mockClear();
    await publisher.publish(input);
    expect(server.fetch.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET"]);
  });

  it("finds an event published on the earliest and latest allowed dates", async () => {
    const { server, publisher } = setup();
    for (const date of ["2025-02-28", "2028-03-01"]) {
      const a = await publisher.publish({ ...input, externalId: `wristplan-${date}`, date });
      const b = await publisher.publish({ ...input, externalId: `wristplan-${date}`, date });
      expect(b.remoteId).toBe(a.remoteId);
    }
    expect(server.events.size).toBe(2);
  });

  it("maps duplicate remote matches to a rejection and creates nothing", async () => {
    const { server, publisher } = setup();
    await publisher.publish(input);
    server.events.set(500, {
      id: 500,
      uid: "dup",
      external_id: input.externalId,
      start_date_local: "2026-03-02T00:00:00",
    });
    const error = await publisher.publish(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublisherRejectedError);
    expect((error as Error).message).not.toContain("share external_id");
    expect(server.events.size).toBe(2);
  });

  it.each([
    ["hr", "HR"],
    ["pace", "PACE"],
    ["power", "POWER"],
  ] as const)("maps target %s to %s", async (target, expected) => {
    const { server, publisher } = setup();
    await publisher.publish({ ...input, target });
    const [, init] = server.fetch.mock.calls.find(([, i]) => i?.method === "POST") ?? [];
    expect(JSON.parse(String(init?.body)).target).toBe(expected);
  });

  it("maps a timeout abort to a transient error without detail", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("secret-timeout-detail", "TimeoutError"));
    const publisher = createIntervalsPublisher(
      createIntervalsClient({ apiKey: "fake-key", athleteId: "0", fetch: fetchMock }),
    );
    const error = await publisher.remove("5").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublisherTransientError);
    expect(String(error)).not.toContain("secret-timeout-detail");
  });

  it("maps a network failure to a transient error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("boom"));
    const publisher = createIntervalsPublisher(
      createIntervalsClient({ apiKey: "fake-key", athleteId: "0", fetch: fetchMock }),
    );
    const error = await publisher.publish(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublisherTransientError);
    expect((error as PublisherTransientError).status).toBeUndefined();
  });

  it("maps client validation and malformed responses to a rejection", async () => {
    const { server, publisher } = setup();
    await expect(publisher.publish({ ...input, date: "2026-02-30" })).rejects.toBeInstanceOf(
      PublisherRejectedError,
    );
    server.respondWith(() => new Response("{}", { status: 200 }));
    await expect(publisher.publish(input)).rejects.toBeInstanceOf(PublisherRejectedError);
  });

  it("rethrows unknown errors untouched", async () => {
    const boom = new TypeError("bug");
    const publisher = createIntervalsPublisher({
      findWorkoutByExternalId: () => Promise.reject(boom),
      createWorkout: () => Promise.reject(boom),
      rescheduleWorkout: () => Promise.reject(boom),
      deleteWorkout: () => Promise.reject(boom),
    });
    await expect(publisher.publish(input)).rejects.toBe(boom);
  });
});
