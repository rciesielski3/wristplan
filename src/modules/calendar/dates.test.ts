import { describe, expect, it } from "vitest";
import {
  assertListRange,
  assertScheduleDate,
  MAX_FUTURE_DAYS,
  MAX_LIST_RANGE_DAYS,
  MAX_PAST_DAYS,
  parseDay,
} from "./dates";
import { ScheduleValidationError } from "./errors";

const now = new Date("2026-06-15T23:59:59Z");

describe("parseDay", () => {
  it.each(["2024-02-29", "2026-12-31", "2026-01-01"])("accepts %s", (d) => {
    expect(parseDay(d)).toBe(Date.parse(d));
  });

  it.each([
    "2026-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-04-31",
    "2026-1-1",
    "2026-01-01T00:00:00",
    " 2026-01-01",
    "",
    "tomorrow",
    "2100-02-29",
    "2026-01-01\n",
    "2026-01-01 ",
    "+2026-01-01",
    "02026-01-01",
    "2026/01/01",
    "2026-01-1",
    "0000-01-01",
    "0050-01-01",
    "２０２６-01-01",
  ])("rejects %j", (d) => {
    expect(() => parseDay(d)).toThrow(ScheduleValidationError);
  });

  it.each([20260101, null, undefined, {}, ["2026-01-01"], new Date(0)])(
    "rejects non-string %j",
    (v) => {
      expect(() => parseDay(v as unknown as string)).toThrow(ScheduleValidationError);
    },
  );

  it("accepts 2000-02-29 (divisible by 400) and 2028-02-29", () => {
    expect(() => parseDay("2000-02-29")).not.toThrow();
    expect(() => parseDay("2028-02-29")).not.toThrow();
  });
});

describe("assertScheduleDate", () => {
  const offset = (days: number) =>
    new Date(Date.parse("2026-06-15") + days * 86_400_000).toISOString().slice(0, 10);

  it("accepts today and both window edges", () => {
    for (const d of ["2026-06-15", offset(-MAX_PAST_DAYS), offset(MAX_FUTURE_DAYS)]) {
      expect(() => assertScheduleDate(d, now)).not.toThrow();
    }
  });

  it("rejects one day beyond either edge", () => {
    for (const d of [
      offset(-MAX_PAST_DAYS - 1),
      offset(MAX_FUTURE_DAYS + 1),
      "1999-01-01",
      "9999-12-31",
    ]) {
      expect(() => assertScheduleDate(d, now)).toThrow(/window/);
    }
  });

  it("anchors the window to the injected UTC day, not the process time zone", () => {
    const justAfterMidnight = new Date("2026-06-16T00:00:00Z");
    expect(() => assertScheduleDate("2026-06-16", justAfterMidnight)).not.toThrow();
    const minusEdge = new Date(Date.parse("2026-06-16") - MAX_PAST_DAYS * 86_400_000);
    const edge = minusEdge.toISOString().slice(0, 10);
    expect(() => assertScheduleDate(edge, justAfterMidnight)).not.toThrow();
    expect(() => assertScheduleDate(edge, new Date("2026-06-17T00:00:00Z"))).toThrow(/window/);
  });

  it("rejects 2026-02-29 and malformed values", () => {
    expect(() => assertScheduleDate("2026-02-29", now)).toThrow(ScheduleValidationError);
    expect(() => assertScheduleDate(undefined as unknown as string, now)).toThrow(
      ScheduleValidationError,
    );
  });

  it("accepts a leap day inside the window", () => {
    expect(() => assertScheduleDate("2028-02-29", now)).not.toThrow();
  });
});

describe("assertListRange", () => {
  it("accepts equal bounds and the maximum span", () => {
    expect(() => assertListRange("2026-01-01", "2026-01-01")).not.toThrow();
    expect(() => assertListRange("2026-01-01", "2027-01-02")).not.toThrow();
    expect(MAX_LIST_RANGE_DAYS).toBe(366);
  });

  it("rejects inverted and oversized ranges and bad dates", () => {
    expect(() => assertListRange("2026-01-02", "2026-01-01")).toThrow(/after/);
    expect(() => assertListRange("2026-01-01", "2027-01-03")).toThrow(/at most/);
    expect(() => assertListRange("nope", "2026-01-01")).toThrow(ScheduleValidationError);
  });
});
