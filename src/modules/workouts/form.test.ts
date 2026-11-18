import { describe, expect, it } from "vitest";
import { formatClock, parseClock, parseKm } from "./form";
import {
  blankValues,
  changeTarget,
  defaultValues,
  editableForm,
  emptyForm,
  formToWorkout,
  lastValues,
  moveItem,
  newInner,
  newLeaf,
  newRepeat,
  summarizeWorkout,
  type Workout,
  type WorkoutForm,
  workoutToForm,
} from "./index";
import type { Target } from "./model";
import { validateWorkout } from "./validate";

const ok = (form: WorkoutForm): Workout => {
  const r = validateWorkout(formToWorkout(form));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.workout;
};

describe("clock and km parsing", () => {
  it.each([
    ["10:00", 600],
    ["5:05", 305],
    ["5:5", 305],
    ["7", 420],
    [" 1:30 ", 90],
  ])("parses %s", (text, seconds) => expect(parseClock(text)).toBe(seconds));
  it.each(["", "abc", "1:60", "1:2:3", "-1", "1.5", "99999"])("rejects %s", (text) =>
    expect(parseClock(text)).toBeNaN(),
  );
  it("formats clocks", () => expect(formatClock(305)).toBe("5:05"));
  it.each([
    ["5", 5000],
    ["2,5", 2500],
    ["0.4", 400],
  ])("parses km %s", (text, m) => expect(parseKm(text)).toBe(m));
  it.each(["", "x", "1.2345", "-1"])("rejects km %s", (t) => expect(parseKm(t)).toBeNaN());
});

const leaf = <K extends "warmup" | "work" | "recovery" | "cooldown">(
  kind: K,
  seconds: number,
  target: Target,
) => ({ kind, end: { type: "time", seconds }, target }) as const;
const hr = (zone: number): Target => ({ type: "hr", zone });

const roundTrip = (workout: Workout) => {
  const form = workoutToForm(workout);
  const r = validateWorkout(formToWorkout(form));
  expect(r.ok && r.workout).toEqual(workout);
  const keys = form.steps.flatMap((s) => [
    s.key,
    ...(s.kind === "repeat" ? s.steps.map((i) => i.key) : []),
  ]);
  expect(new Set(keys).size).toBe(keys.length);
  return form;
};

describe("form <-> workout", () => {
  it("converts the default form once named", () => {
    expect(ok({ ...emptyForm(), name: "Easy" }).steps).toEqual([leaf("warmup", 600, hr(2))]);
  });

  it("round-trips the verified Z1/Z4/Z1 example with a repeat", () => {
    const form = roundTrip({
      name: "Z",
      sport: "run",
      steps: [
        leaf("warmup", 600, hr(1)),
        {
          kind: "repeat",
          times: 3,
          steps: [leaf("work", 180, hr(4)), leaf("recovery", 120, hr(1))],
        },
        leaf("cooldown", 300, hr(5)),
      ],
    });
    expect(form.targetType).toBe("hr");
  });

  it("round-trips per-step pace targets and distance ends", () => {
    const pace = (fast: number, slow: number): Target => ({
      type: "pace",
      fastSecPerKm: fast,
      slowSecPerKm: slow,
    });
    const form = roundTrip({
      name: "P",
      sport: "run",
      steps: [
        { kind: "warmup", end: { type: "distance", meters: 1500 }, target: pace(330, 360) },
        { kind: "repeat", times: 2, steps: [leaf("work", 240, pace(250, 260))] },
      ],
    });
    expect(form.targetType).toBe("pace");
  });

  it.each(["watts", "percent_ftp"] as const)("round-trips per-step %s power targets", (unit) => {
    const power = (min: number, max: number): Target => ({ type: "power", unit, min, max });
    const form = roundTrip({
      name: "W",
      sport: "run",
      steps: [
        leaf("warmup", 600, power(100, 150)),
        { kind: "repeat", times: 2, steps: [leaf("work", 60, power(200, 250))] },
      ],
    });
    expect(form.powerUnit).toBe(unit);
  });

  it("surfaces unparseable fields as validation issues at the right path", () => {
    const form: WorkoutForm = {
      name: "Bad",
      targetType: "hr",
      powerUnit: "watts",
      steps: [
        { ...newLeaf(1), amount: "soon", values: { ...defaultValues(), zone: "x" } },
        { ...newRepeat(2), times: "" },
      ],
    };
    const r = validateWorkout(formToWorkout(form));
    const paths = r.ok ? [] : r.issues.map((i) => i.path);
    expect(paths).toContain("steps[0].end.seconds");
    expect(paths).toContain("steps[1].times");
    expect(paths).toContain("steps[0].target.zone");
  });

  it("falls back to defaults for workouts without steps", () => {
    const empty = { name: "x", sport: "run", steps: [] } as Workout;
    expect(() => workoutToForm(empty)).toThrow();
  });

  it("changing the target type or power unit clears step values, same choice keeps them", () => {
    const form = { ...emptyForm(), name: "n", steps: [newLeaf(1), newRepeat(2)] };
    expect(changeTarget(form, "hr", "watts")).toBe(form);
    expect(changeTarget(form, "hr", "percent_ftp")).toBe(form);
    const pace = changeTarget(form, "pace", "percent_ftp");
    const values = pace.steps.flatMap((s) =>
      (s.kind === "repeat" ? s.steps : [s]).map((x) => x.values),
    );
    expect(values).toHaveLength(3);
    for (const v of values) expect(v).toEqual(blankValues());
    const r = validateWorkout(formToWorkout(pace));
    expect(r.ok).toBe(false);
    const power = changeTarget(pace, "power", "watts");
    expect(power.powerUnit).toBe("watts");
    expect(changeTarget(power, "power", "watts")).toBe(power);
    expect(changeTarget(power, "power", "percent_ftp").powerUnit).toBe("percent_ftp");
  });

  it("new steps default to the previous step's values", () => {
    const custom = { ...defaultValues(), zone: "4" };
    expect(lastValues(emptyForm())).toEqual(defaultValues());
    expect(lastValues({ ...emptyForm(), steps: [] })).toEqual(defaultValues());
    expect(lastValues({ ...emptyForm(), steps: [newLeaf(1, "work", custom)] })).toEqual(custom);
    expect(lastValues({ ...emptyForm(), steps: [newRepeat(1, custom)] })).toEqual(custom);
    expect(lastValues({ ...emptyForm(), steps: [{ ...newRepeat(1), steps: [] }] })).toEqual(
      defaultValues(),
    );
  });

  it("builds new items", () => {
    expect(newInner(1).kind).toBe("work");
    expect(newRepeat(10).steps.map((s) => s.key)).toEqual([11, 12]);
  });

  it("moves items safely", () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, 3)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 5, 0)).toEqual([1, 2, 3]);
  });
});

describe("summarizeWorkout", () => {
  it("counts leaf steps and totals repeated time", () => {
    const w = ok({
      name: "S",
      targetType: "hr",
      powerUnit: "watts",
      steps: [newLeaf(1, "warmup"), { ...newRepeat(2), times: "2" }],
    });
    expect(summarizeWorkout(w)).toEqual({
      stepCount: 3,
      totalSeconds: 600 + 2 * 360,
      targetType: "hr",
    });
  });
  it("has no total when any step is distance based", () => {
    const w = ok({
      name: "S",
      targetType: "hr",
      powerUnit: "watts",
      steps: [{ ...newLeaf(1), endType: "distance", amount: "5" }, newLeaf(2)],
    });
    expect(summarizeWorkout(w).totalSeconds).toBeNull();
  });
});

describe("editableForm", () => {
  const power = (unit: "watts" | "percent_ftp"): Target => ({
    type: "power",
    unit,
    min: 50,
    max: 90,
  });

  it("returns the form for a workout it represents exactly", () => {
    const w: Workout = {
      name: "ok",
      sport: "run",
      steps: [leaf("warmup", 600, hr(1)), leaf("work", 180, hr(4))],
    };
    expect(editableForm(w)).toEqual(workoutToForm(w));
  });

  it("refuses a workout with mixed power units instead of converting it", () => {
    const w: Workout = {
      name: "mixed",
      sport: "run",
      steps: [leaf("warmup", 600, power("watts")), leaf("work", 180, power("percent_ftp"))],
    };
    expect(editableForm(w)).toBeNull();
  });

  it("refuses any workout the form would change (mixed target types, odd values)", () => {
    const mixed: Workout = {
      name: "m",
      sport: "run",
      steps: [leaf("warmup", 600, hr(1)), leaf("work", 180, power("watts"))],
    };
    expect(editableForm(mixed)).toBeNull();
    const fractional = {
      name: "f",
      sport: "run",
      steps: [leaf("warmup", 0.5, hr(1))],
    } as Workout;
    expect(editableForm(fractional)).toBeNull();
  });
});
