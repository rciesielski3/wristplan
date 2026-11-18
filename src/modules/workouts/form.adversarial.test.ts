import { describe, expect, it } from "vitest";
import { formatClock, moveItem, parseClock, parseKm } from "./form";
import { formToWorkout, summarizeWorkout, type Workout, workoutToForm } from "./index";
import { validateWorkout } from "./validate";

describe("parseClock edge cases", () => {
  it.each([
    ["1:5", 65],
    ["0:00", 0],
    ["0", 0],
    ["9999:59", 9999 * 60 + 59],
    ["\t2:30\n", 150],
  ])("accepts %j", (text, seconds) => expect(parseClock(text)).toBe(seconds));

  it.each([
    "01:60",
    ":30",
    "99:99",
    "1:",
    "-1:30",
    "1:-5",
    "١٢:٣٠",
    "1:３０",
    "1 : 30",
    "1:30:00",
    "NaN",
    "Infinity",
    "1e3",
    "0x10",
    "10000:00",
    "+5",
  ])("rejects %j as NaN", (text) => expect(parseClock(text)).toBeNaN());
});

describe("parseKm edge cases", () => {
  it.each([
    ["0,5", 500],
    ["12.345", 12345],
    [" 3 ", 3000],
    ["0.001", 1],
    ["999", 999000],
  ])("accepts %j", (text, m) => expect(parseKm(text)).toBe(m));

  it.each(["1,2,3", "1.2.3", "1,", ".5", "1e2", "Infinity", "NaN", "٣", "1000", "-0.5", "1 .5"])(
    "rejects %j as NaN",
    (text) => expect(parseKm(text)).toBeNaN(),
  );
});

it("formats clocks with padded seconds and unbounded minutes", () => {
  expect(formatClock(0)).toBe("0:00");
  expect(formatClock(59)).toBe("0:59");
  expect(formatClock(3600)).toBe("60:00");
});

describe("moveItem bounds", () => {
  it.each([
    [-1, 0],
    [1.5, 0],
    [3, 0],
    [0, 3],
    [0, 1.5],
    [0, -1],
  ])("leaves the list untouched for from=%d to=%d", (from, to) => {
    const items = [1, 2, 3];
    expect(moveItem(items, from, to)).toEqual([1, 2, 3]);
    expect(items).toEqual([1, 2, 3]);
  });

  it("moves arrays that contain undefined", () => {
    expect(moveItem([undefined, 1], 0, 1)).toEqual([1, undefined]);
  });

  it("returns a copy, never the same array", () => {
    const items = [1];
    expect(moveItem(items, 0, 0)).not.toBe(items);
  });
});

describe("summarizeWorkout", () => {
  it("does not recover a total after a distance step precedes a time step", () => {
    const w: Workout = {
      name: "d",
      sport: "run",
      steps: [
        { kind: "work", end: { type: "distance", meters: 1000 }, target: { type: "hr", zone: 2 } },
        { kind: "work", end: { type: "time", seconds: 60 }, target: { type: "hr", zone: 2 } },
      ],
    };
    expect(summarizeWorkout(w).totalSeconds).toBeNull();
  });

  it("multiplies repeated time by the repeat count only", () => {
    const w: Workout = {
      name: "r",
      sport: "run",
      steps: [
        {
          kind: "repeat",
          times: 4,
          steps: [
            { kind: "work", end: { type: "time", seconds: 30 }, target: { type: "hr", zone: 2 } },
          ],
        },
        { kind: "cooldown", end: { type: "time", seconds: 10 }, target: { type: "hr", zone: 2 } },
      ],
    };
    expect(summarizeWorkout(w)).toMatchObject({ stepCount: 2, totalSeconds: 130 });
  });
});

describe("editing a stored workout", () => {
  it("keeps per-step targets of the same type when re-saved unchanged", () => {
    const stored: Workout = {
      name: "Zones",
      sport: "run",
      steps: [
        { kind: "warmup", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 2 } },
        { kind: "work", end: { type: "time", seconds: 180 }, target: { type: "hr", zone: 4 } },
      ],
    };
    const result = validateWorkout(formToWorkout(workoutToForm(stored)));
    expect(result.ok && result.workout).toEqual(stored);
  });
});
