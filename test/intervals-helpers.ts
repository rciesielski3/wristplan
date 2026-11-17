import { vi } from "vitest";
import { createIntervalsClient } from "../src/modules/intervals/index";

export const KEY = "fake-intervals-test-key";
export const TOKEN = Buffer.from(`API_KEY:${KEY}`).toString("base64");
export const BASIC = `Basic ${TOKEN}`;
export const BASE = "https://intervals.icu/api/v1";

export const event = {
  id: 7,
  external_id: "wristplan-x-1",
  start_date_local: "2026-01-02T00:00:00",
  push_errors: null,
  name: "n",
};

export const input = {
  name: "Tempo",
  date: "2026-01-02",
  type: "Run",
  target: "HR",
  description: "- 10m Z1 HR",
  externalId: "wristplan-x-1",
} as const;

export const reply = (status: number, body: unknown) =>
  new Response(status === 204 ? null : typeof body === "string" ? body : JSON.stringify(body), {
    status,
  });

export const setup = (responses: Response[] = [], athleteId = "0") => {
  const fetchMock = vi.fn<typeof fetch>();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  const client = createIntervalsClient({ apiKey: KEY, athleteId, fetch: fetchMock });
  return { client, fetchMock };
};

export const callOf = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] ?? [];
  return {
    url: String(url),
    method: init?.method,
    headers: new Headers(init?.headers),
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    rawBody: init?.body,
  };
};

export const setupOwnedDelete = (deleteReply: Response, id = event.id, athleteId = "0") =>
  setup([reply(200, { ...event, id }), deleteReply], athleteId);

export const methodsOf = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) =>
  fetchMock.mock.calls.map((_, i) => callOf(fetchMock, i).method);
