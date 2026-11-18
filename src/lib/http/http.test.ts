import { describe, expect, it } from "vitest";
import { isHostAllowed, json, rejectCrossOrigin, rejectForeignHost } from "./index";

describe("rejectForeignHost", () => {
  const req = (host: string) => new Request("http://x/", { headers: { host } });
  it("allows loopback and extra hosts, blocks others", () => {
    expect(rejectForeignHost(req("localhost:3000"))).toBeNull();
    expect(rejectForeignHost(req("box.lan"), "box.lan")).toBeNull();
    expect(rejectForeignHost(req("evil.example"))?.status).toBe(403);
  });
  it("json sets no-store", () => {
    expect(json({}, 200).headers.get("cache-control")).toBe("no-store");
  });
});

describe("rejectCrossOrigin", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://x/", { method: "POST", headers: { host: "localhost:3000", ...headers } });
  it("rejects a foreign host before looking at Origin", async () => {
    const res = rejectCrossOrigin(req({ host: "evil.example", origin: "http://evil.example" }));
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "forbidden" });
  });
  it("accepts same-site loopback variants and rejects look-alike origins", () => {
    expect(rejectCrossOrigin(req({ host: "[::1]:3000", origin: "http://[::1]:3000" }))).toBeNull();
    expect(
      rejectCrossOrigin(req({ host: "LOCALHOST:3000", "sec-fetch-site": "same-origin" })),
    ).toBe(null);
    expect(rejectCrossOrigin(req({ origin: "http://localhost:3001" }))?.status).toBe(403);
    expect(rejectCrossOrigin(req({ origin: "not a url" }))?.status).toBe(403);
    expect(rejectCrossOrigin(req({ origin: "http://localhost:3000.evil.example" }))?.status).toBe(
      403,
    );
  });
  it("ignores extra-host entries that are blank", () => {
    expect(isHostAllowed("", " , ,")).toBe(false);
    expect(isHostAllowed("[::1]:9")).toBe(true);
  });
});
