import { describe, expect, it } from "vitest";
import { event, input, reply, setup } from "../../../test/intervals-helpers.js";
import {
  IntervalsApiError,
  IntervalsNotFoundError,
  IntervalsResponseError,
  IntervalsValidationError,
} from "./index.js";

describe("response guards (create)", () => {
  const { id: _i, ...noId } = event;
  it.each<[string, unknown]>([
    ["missing id", noId],
    ["string id", { ...event, id: "7" }],
    ["null id", { ...event, id: null }],
    ["null body", null],
    ["array body", [event]],
    ["string body", "ok"],
    ["numeric body", 5],
    ["missing start_date_local", { id: 1 }],
    ["numeric external_id", { ...event, external_id: 5 }],
    ["push_errors string", { ...event, push_errors: "x" }],
    ["push_errors object", { ...event, push_errors: { a: 1 } }],
  ])("rejects %s with IntervalsResponseError", async (_n, body) => {
    const { client } = setup([reply(200, JSON.stringify(body))]);
    await expect(client.createWorkout(input)).rejects.toBeInstanceOf(IntervalsResponseError);
  });

  it.each<[string, unknown, unknown]>([
    ["empty array", [], null],
    ["null", null, null],
    ["absent", undefined, null],
    ["non-empty", ["a", { code: 1 }], ["a", { code: 1 }]],
  ])("push_errors %s maps to %j", async (_n, pe, expected) => {
    const body = {
      ...event,
      ...(pe === undefined ? { push_errors: undefined } : { push_errors: pe }),
    };
    const { client } = setup([reply(200, body)]);
    await expect(client.createWorkout(input)).resolves.toMatchObject({ pushErrors: expected });
  });

  it("returns push errors instead of throwing", async () => {
    const { client } = setup([reply(200, { ...event, push_errors: ["bad"] })]);
    await expect(client.createWorkout(input)).resolves.toMatchObject({
      id: 7,
      pushErrors: ["bad"],
    });
  });

  it("maps absent external_id to null", async () => {
    const { client } = setup([reply(200, { id: 1, start_date_local: "2026-01-02T00:00:00" })]);
    await expect(client.createWorkout(input)).resolves.toMatchObject({ externalId: null });
  });

  it("(known defect) rejects ids that cannot be real event ids", async () => {
    for (const id of [0, -3, 1.5]) {
      const { client } = setup([reply(200, { ...event, id })]);
      await expect(client.createWorkout(input)).rejects.toBeInstanceOf(IntervalsResponseError);
    }
  });
});

describe("response guards (reschedule)", () => {
  it("does not PUT when the GET response is malformed", async () => {
    const { client, fetchMock } = setup([reply(200, [])]);
    await expect(client.rescheduleWorkout(7, "2026-02-03")).rejects.toBeInstanceOf(
      IntervalsResponseError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed PUT response", async () => {
    const { client } = setup([reply(200, event), reply(200, { id: "x" })]);
    await expect(client.rescheduleWorkout(7, "2026-02-03")).rejects.toBeInstanceOf(
      IntervalsResponseError,
    );
  });

  it("surfaces PUT failure after a successful GET", async () => {
    const { client, fetchMock } = setup([reply(200, event), reply(500, "boom")]);
    await expect(client.rescheduleWorkout(7, "2026-02-03")).rejects.toMatchObject({
      status: 500,
      method: "PUT",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns pushErrors from the PUT response", async () => {
    const { client } = setup([reply(200, event), reply(200, { ...event, push_errors: ["e"] })]);
    await expect(client.rescheduleWorkout(7, "2026-02-03")).resolves.toMatchObject({
      pushErrors: ["e"],
    });
  });
});

describe("status mapping", () => {
  it("404 on GET during reschedule is a not-found error for GET and sends no PUT", async () => {
    const { client, fetchMock } = setup([reply(404, "x")]);
    const err = await client.rescheduleWorkout(7, "2026-02-03").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsNotFoundError);
    expect(err).toMatchObject({ status: 404, method: "GET", path: "/athlete/0/events/7" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("404 on DELETE is a not-found error for DELETE", async () => {
    const { client } = setup([reply(404, "")]);
    const err = await client.deleteWorkout(7, { allowForeign: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsNotFoundError);
    expect(err).toMatchObject({ status: 404, method: "DELETE" });
  });

  it("404 on DELETE after an owned GET is a not-found error for DELETE", async () => {
    const { client, fetchMock } = setup([reply(200, event), reply(404, "")]);
    const err = await client.deleteWorkout(7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsNotFoundError);
    expect(err).toMatchObject({ status: 404, method: "DELETE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 409, 429, 500, 503])(
    "HTTP %i on DELETE after an owned GET is an api error for DELETE",
    async (status) => {
      const { client, fetchMock } = setup([reply(200, event), reply(status, "")]);
      const err = await client.deleteWorkout(7).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IntervalsApiError);
      expect(err).toMatchObject({ status, method: "DELETE", path: "/athlete/0/events/7" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("includes a short detail and truncates it when DELETE fails after an owned GET", async () => {
    const { client } = setup([reply(200, event), reply(500, "y".repeat(5000))]);
    const err = (await client.deleteWorkout(7).catch((e: unknown) => e)) as Error;
    expect(
      err.message.startsWith("intervals.icu DELETE /athlete/0/events/7 failed with 500: "),
    ).toBe(true);
    expect(err.message.endsWith(`: ${"y".repeat(200)}`)).toBe(true);
  });

  it("network failure and timeout on DELETE after an owned GET are wrapped as status 0", async () => {
    const { vi } = await import("vitest");
    const { createIntervalsClient } = await import("./index.js");
    for (const failure of [new TypeError("fetch failed"), new DOMException("t", "TimeoutError")]) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(reply(200, event))
        .mockRejectedValueOnce(failure);
      const client = createIntervalsClient({ apiKey: "k", athleteId: "0", fetch: fetchMock });
      await expect(client.deleteWorkout(7)).rejects.toMatchObject({ status: 0, method: "DELETE" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("failure reading the DELETE body after an owned GET is an api error", async () => {
    const { client } = setup([
      reply(200, event),
      {
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error("reset")),
      } as unknown as Response,
    ]);
    await expect(client.deleteWorkout(7)).rejects.toMatchObject({ status: 0, method: "DELETE" });
  });

  it("a plain-text 200 DELETE body after an owned GET is success", async () => {
    const { client } = setup([reply(200, event), reply(200, "deleted")]);
    await expect(client.deleteWorkout(7)).resolves.toBeUndefined();
  });

  it("guarded delete sends an abort signal on both the GET and the DELETE", async () => {
    const { client, fetchMock } = setup([reply(200, event), reply(204, "")]);
    await client.deleteWorkout(7);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBeDefined();
  });

  it("404 on PUT (event removed between GET and PUT) is not-found for PUT", async () => {
    const { client } = setup([reply(200, event), reply(404, "")]);
    await expect(client.rescheduleWorkout(7, "2026-02-03")).rejects.toMatchObject({
      name: "IntervalsNotFoundError",
      method: "PUT",
    });
  });

  it.each([400, 401, 403, 409, 422, 429, 500, 502, 503])(
    "maps HTTP %i to IntervalsApiError carrying status, method and query-free path",
    async (status) => {
      const { client } = setup([reply(status, "")]);
      const err = await client.createWorkout(input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IntervalsApiError);
      expect(err).not.toBeInstanceOf(IntervalsNotFoundError);
      expect(err).toMatchObject({ status, method: "POST", path: "/athlete/0/events" });
      expect((err as Error).message).toBe(
        `intervals.icu POST /athlete/0/events failed with ${status}`,
      );
    },
  );

  it("includes a short response detail in the message", async () => {
    const { client } = setup([reply(500, "upstream down")]);
    await expect(client.deleteWorkout(7, { allowForeign: true })).rejects.toThrow(
      "intervals.icu DELETE /athlete/0/events/7 failed with 500: upstream down",
    );
  });

  it("truncates long details to 200 characters", async () => {
    const { client } = setup([reply(500, "y".repeat(5000))]);
    const err = (await client
      .deleteWorkout(7, { allowForeign: true })
      .catch((e: unknown) => e)) as Error;
    expect(err.message.endsWith(`: ${"y".repeat(200)}`)).toBe(true);
  });

  it("(known defect) network failure error path omits the query string like HTTP errors do", async () => {
    const { vi } = await import("vitest");
    const { createIntervalsClient } = await import("./index.js");
    const original = new TypeError("fetch failed");
    const client = createIntervalsClient({
      apiKey: "k",
      athleteId: "0",
      fetch: vi.fn<typeof fetch>().mockRejectedValue(original),
    });
    const err = (await client.createWorkout(input).catch((e: unknown) => e)) as IntervalsApiError;
    expect(err).toBeInstanceOf(IntervalsApiError);
    expect(err.status).toBe(0);
    expect(err.cause).toBeUndefined();
    expect(err.path).toBe("/athlete/0/events");
  });

  it("timeout/abort rejection is wrapped as status 0", async () => {
    const { vi } = await import("vitest");
    const { createIntervalsClient } = await import("./index.js");
    const client = createIntervalsClient({
      apiKey: "k",
      athleteId: "0",
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timed out", "TimeoutError")),
    });
    await expect(client.deleteWorkout(7, { allowForeign: true })).rejects.toMatchObject({
      status: 0,
      method: "DELETE",
    });
  });

  it("(known defect) wraps a failure while reading the response body as an IntervalsApiError", async () => {
    const { client } = setup([
      {
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error("stream reset")),
      } as unknown as Response,
    ]);
    await expect(client.deleteWorkout(7, { allowForeign: true })).rejects.toBeInstanceOf(
      IntervalsApiError,
    );
  });

  it("(known defect) never sends a request that hangs forever: passes an abort signal", async () => {
    const { client, fetchMock } = setup([reply(204, "")]);
    await client.deleteWorkout(7, { allowForeign: true });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
  });

  it("(known defect) a successful DELETE is not reported as failure when the server returns a plain-text body", async () => {
    const { client } = setup([reply(200, "deleted")]);
    await expect(client.deleteWorkout(7, { allowForeign: true })).resolves.toBeUndefined();
  });

  it("validation errors are distinct from API errors", async () => {
    const { client } = setup();
    const err = await client.deleteWorkout(0, { allowForeign: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsValidationError);
    expect(err).not.toBeInstanceOf(IntervalsApiError);
  });
});
