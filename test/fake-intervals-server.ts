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
      // Live behaviour: a client uid is ignored and upsertOnUid never dedupes, so every POST creates.
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const id = next++;
      const event = { ...body, id, uid: `generated-${id}` } as Event;
      events.set(id, event);
      return json(200, event);
    }
    if (method === "GET" && url.pathname.endsWith("/events")) {
      const oldest = url.searchParams.get("oldest");
      const newest = url.searchParams.get("newest");
      if (!oldest || !newest) return json(422, { error: "oldest and newest are required" });
      return json(
        200,
        [...events.values()].filter((e) => {
          const day = e.start_date_local.slice(0, 10);
          return day >= oldest && day <= newest;
        }),
      );
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
