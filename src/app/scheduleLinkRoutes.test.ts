import { describe, expect, it, vi } from "vitest";

vi.mock("./scheduleDeps", () => ({ scheduleDeps: () => ({}) }));

import * as link from "./api/schedule/[id]/link/route";

const verbs = (m: object) =>
  Object.keys(m)
    .filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))
    .sort();

describe("schedule link route module", () => {
  it("exports only PUT and DELETE so Next answers 405 for the rest", () => {
    expect(verbs(link)).toEqual(["DELETE", "PUT"]);
  });

  it("runs on the node runtime and is never cached", () => {
    expect(link.runtime).toBe("nodejs");
    expect(link.dynamic).toBe("force-dynamic");
  });

  it("forwards the route id and refuses a cross-site request before touching deps", async () => {
    const ctx = { params: Promise.resolve({ id: "s1" }) };
    const headers = { host: "localhost:3100", "sec-fetch-site": "cross-site" };
    const put = new Request("http://localhost:3100/api/schedule/s1/link", {
      method: "PUT",
      body: '{"none":true}',
      headers: { ...headers, "content-type": "application/json" },
    });
    const del = new Request("http://localhost:3100/api/schedule/s1/link", {
      method: "DELETE",
      headers,
    });
    expect((await link.PUT(put, ctx)).status).toBe(403);
    expect((await link.DELETE(del, ctx)).status).toBe(403);
  });
});
