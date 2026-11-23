import { describe, expect, it } from "vitest";
import { formatDelta as calendarFormatDelta } from "../calendar/view";
import { formatDelta, formatOf, formatPercent } from "./format";

describe("formatPercent edge cases", () => {
  it.each([
    [0, "0%"],
    [-0, "0%"],
    [1, "100%"],
    [0.004, "0%"],
    [0.005, "1%"],
    [0.0049, "0%"],
    [0.995, "100%"],
    [1.5, "150%"],
    [1e12, "100000000000000%"],
  ])("%s -> %s", (ratio, text) => {
    expect(formatPercent(ratio)).toBe(text);
  });

  it.each([[null], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])(
    "%s renders the empty marker",
    (ratio) => {
      expect(formatPercent(ratio)).toBe("—");
    },
  );

  it("never prints negative zero", () => {
    expect(formatPercent(-0.001)).toBe("0%");
    expect(formatPercent(-0.001)).not.toContain("-");
  });
});

describe("formatOf edge cases", () => {
  it("shows both numbers and a percentage", () => {
    expect(formatOf(0, 5)).toBe("0 of 5 (0%)");
    expect(formatOf(5, 5)).toBe("5 of 5 (100%)");
    expect(formatOf(1, 3)).toBe("1 of 3 (33%)");
    expect(formatOf(2, 3)).toBe("2 of 3 (67%)");
  });

  it.each([
    [0, 0],
    [1, 0],
    [1, -1],
    [Number.NaN, 1],
    [1, Number.NaN],
    [Number.POSITIVE_INFINITY, 1],
    [1, Number.POSITIVE_INFINITY],
  ])("(%s, %s) renders the empty marker", (part, whole) => {
    expect(formatOf(part, whole)).toBe("—");
  });
});

describe("formatDelta edge cases", () => {
  it("returns the empty marker for null and non-finite parts", () => {
    expect(formatDelta(null, "duration")).toBe("—");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatDelta({ absolute: bad, percent: 1 }, "duration")).toBe("—");
      expect(formatDelta({ absolute: 1, percent: bad }, "distance")).toBe("—");
    }
  });

  it("prints no sign for zero, negative zero and sub-precision changes", () => {
    expect(formatDelta({ absolute: 0, percent: 0 }, "duration")).toBe("0:00 (0%)");
    expect(formatDelta({ absolute: -0, percent: -0 }, "duration")).toBe("0:00 (0%)");
    expect(formatDelta({ absolute: 0.4, percent: 0.04 }, "duration")).toBe("0:00 (0%)");
    expect(formatDelta({ absolute: 4, percent: 0.4 }, "distance")).toBe("0.00 km (0%)");
    expect(formatDelta({ absolute: -4, percent: -0.4 }, "distance")).toBe("0.00 km (0%)");
    expect(formatDelta({ absolute: -0.4, percent: -0.4 }, "duration")).toBe("0:00 (0%)");
  });

  it("prefixes + and - consistently with the absolute and percent signs", () => {
    expect(formatDelta({ absolute: 600, percent: 20 }, "duration")).toBe("+10:00 (+20%)");
    expect(formatDelta({ absolute: -600, percent: -20 }, "duration")).toBe("-10:00 (-20%)");
    expect(formatDelta({ absolute: 1500, percent: 12.4 }, "distance")).toBe("+1.50 km (+12%)");
    expect(formatDelta({ absolute: -1500, percent: -12.4 }, "distance")).toBe("-1.50 km (-12%)");
    expect(formatDelta({ absolute: 3_600_000, percent: 1e6 }, "duration")).toBe(
      "+1000:00:00 (+1000000%)",
    );
  });

  it("agrees with the calendar formatDelta on sign and magnitude for whole seconds", () => {
    for (const s of [-7200, -61, -1, 0, 1, 59, 3599, 3600, 86_400]) {
      const analytics = formatDelta(
        { absolute: s, percent: s === 0 ? 0 : 10 * Math.sign(s) },
        "duration",
      );
      expect(analytics.split(" ")[0]).toBe(calendarFormatDelta(s));
    }
  });

  // Defect: sign derives from Math.round(negative / step) which rounds half toward +Infinity, so
  // -0.5 s / -5 m lose the minus while the amount still shows 0:01 / 0.01 km.
  it("keeps the minus sign for a negative change of exactly half a display step (duration)", () => {
    expect(formatDelta({ absolute: -0.5, percent: -1 }, "duration")).toBe("-0:01 (-1%)");
  });
  it("keeps the minus sign for a negative change of exactly half a display step (distance)", () => {
    expect(formatDelta({ absolute: -5, percent: -1 }, "distance")).toBe("-0.01 km (-1%)");
  });
  // Defect: percent rounding is asymmetric for negatives: +1.5 -> +2% but -1.5 -> -1%.
  it("rounds negative percents half away from zero like positives", () => {
    expect(formatDelta({ absolute: -10, percent: -1.5 }, "duration")).toBe("-0:10 (-2%)");
  });
  it("rounds positive .5 percents up", () => {
    expect(formatDelta({ absolute: 10, percent: 1.5 }, "duration")).toBe("+0:10 (+2%)");
  });
});
