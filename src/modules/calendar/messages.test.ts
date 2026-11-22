import { describe, expect, it } from "vitest";
import { scheduleErrorMessage } from "./messages";

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
