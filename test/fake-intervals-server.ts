import { vi } from "vitest";
import { createIntervalsClient } from "../src/modules/intervals/index";

export const SERVER_KEY = "fake-intervals-test-key";

interface Event {
  id: number;
  external_id: string | null;
  uid: string;
  start_date_local: string;
  [key: string]: unknown;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

export function createFakeIntervalsServer() {
  const events = new Map<number, Event>();
  let next = 100;
  let override: ((method: string) => Response | undefined) | undefined;

  const handler = vi.fn<typeof fetch>(async (input, init) => {
    const method = init?.method ?? "GET";
    const forced = override?.(method);
    if (forced) return forced;
    const url = new URL(String(input));
    const id = Number(url.pathname.split("/").pop());
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as Event;
      // Like the real API, upsertOnUid matches the uid field only, never external_id.
      const upsert = url.searchParams.get("upsertOnUid") === "true";
      for (const event of upsert && body.uid ? events.values() : []) {
        if (event.uid === body.uid) {
          Object.assign(event, body);
          return json(200, event);
        }
      }
      const id = next++;
      const event = { ...body, id, uid: body.uid ?? `generated-${id}` };
      events.set(event.id, event);
      return json(200, event);
    }
    const event = events.get(id);
    if (!event) return json(404, { error: "not found" });
    if (method === "GET") return json(200, event);
    if (method === "PUT") {
      Object.assign(event, JSON.parse(String(init?.body)));
      return json(200, event);
    }
    events.delete(id);
    return new Response(null, { status: 204 });
  });

  return {
    events,
    fetch: handler,
    client: createIntervalsClient({ apiKey: SERVER_KEY, athleteId: "0", fetch: handler }),
    dateOf(id: number): string | undefined {
      return events.get(id)?.start_date_local.slice(0, 10);
    },
    seedForeign(date: string): number {
      const id = next++;
      events.set(id, {
        id,
        uid: `seed-${id}`,
        external_id: null,
        start_date_local: `${date}T00:00:00`,
      });
      return id;
    },
    respondWith(fn: ((method: string) => Response | undefined) | undefined) {
      override = fn;
    },
  };
}
