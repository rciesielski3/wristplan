import { describe, expect, it } from "vitest";
import { linkErrorMessage, scheduleErrorMessage } from "./messages";

describe("scheduleErrorMessage", () => {
  it("explains a missing intervals.icu configuration", () => {
    expect(scheduleErrorMessage(503, "intervals.icu is not configured")).toMatch(
      /not configured.*INTERVALS_API_KEY/,
    );
  });
  it("shows the API error with its status", () => {
    expect(scheduleErrorMessage(409, "conflict")).toBe("conflict (409)");
  });
  it("falls back when there is no API error", () => {
    expect(scheduleErrorMessage(500, undefined)).toBe("Request failed (500)");
  });
});

describe("linkErrorMessage", () => {
  it("explains not found and conflict", () => {
    expect(linkErrorMessage(404, "x")).toMatch(/not found/);
    expect(linkErrorMessage(409, "x")).toMatch(/already linked to another plan/);
  });
  it("keeps the server error text for 422 and a generic 503 without the key hint", () => {
    expect(linkErrorMessage(422, "bad id")).toBe("bad id (422)");
    expect(linkErrorMessage(503, "x")).not.toMatch(/INTERVALS_API_KEY/);
  });
  it("does not show the publishing key hint for 503", () => {
    const msg = linkErrorMessage(503, "intervals.icu is not configured");
    expect(msg).toBe("Server unavailable (503). Try again later.");
    expect(msg).not.toContain("INTERVALS_API_KEY");
  });
  it("delegates other statuses", () => {
    expect(linkErrorMessage(500, undefined)).toBe("Request failed (500)");
  });
});
