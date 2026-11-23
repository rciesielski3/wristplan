import { describe, expect, it } from "vitest";
import { formatDelta, formatOf, formatPercent } from "./format";

describe("formatPercent", () => {
  it.each([
    [null, "—"],
    [Number.NaN, "—"],
    [Number.POSITIVE_INFINITY, "—"],
    [0, "0%"],
    [-0, "0%"],
    [0.5, "50%"],
    [2 / 3, "67%"],
    [1.5, "150%"],
  ])("%j -> %s", (input, expected) => {
    expect(formatPercent(input)).toBe(expected);
  });
});

describe("formatOf", () => {
  it("formats x of y", () => {
    expect(formatOf(3, 4)).toBe("3 of 4 (75%)");
    expect(formatOf(0, 5)).toBe("0 of 5 (0%)");
  });
  it("is empty for a zero, negative or non-finite whole", () => {
    expect(formatOf(0, 0)).toBe("—");
    expect(formatOf(1, -1)).toBe("—");
    expect(formatOf(Number.NaN, 2)).toBe("—");
    expect(formatOf(1, Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatDelta", () => {
  it("is empty for null and non-finite", () => {
    expect(formatDelta(null, "duration")).toBe("—");
    expect(formatDelta({ absolute: Number.NaN, percent: 1 }, "duration")).toBe("—");
    expect(formatDelta({ absolute: 1, percent: Number.POSITIVE_INFINITY }, "distance")).toBe("—");
  });
  it("signs durations", () => {
    expect(formatDelta({ absolute: 1800, percent: 12.4 }, "duration")).toBe("+30:00 (+12%)");
    expect(formatDelta({ absolute: -3700, percent: -50 }, "duration")).toBe("-1:01:40 (-50%)");
  });
  it("signs distances", () => {
    expect(formatDelta({ absolute: 5000, percent: 10 }, "distance")).toBe("+5.00 km (+10%)");
    expect(formatDelta({ absolute: -1500, percent: -3 }, "distance")).toBe("-1.50 km (-3%)");
  });
  it("shows no sign on zero, including negative zero and sub-precision changes", () => {
    expect(formatDelta({ absolute: 0, percent: 0 }, "duration")).toBe("0:00 (0%)");
    expect(formatDelta({ absolute: -0, percent: -0 }, "distance")).toBe("0.00 km (0%)");
    expect(formatDelta({ absolute: -0.2, percent: -0.3 }, "duration")).toBe("0:00 (0%)");
    expect(formatDelta({ absolute: -2, percent: 0.2 }, "distance")).toBe("0.00 km (0%)");
  });
});
