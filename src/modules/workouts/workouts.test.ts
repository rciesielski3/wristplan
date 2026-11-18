import { describe, expect, it } from "vitest";
import {
  parseWorkout,
  toIntervalsText,
  validateWorkout,
  type Workout,
  WorkoutValidationError,
  workoutTargetType,
} from "./index";

const hr = (zone: number) => ({ type: "hr", zone });
const time = (seconds: number) => ({ type: "time", seconds });

const spikeWorkout = {
  name: "Intervals",
  sport: "run",
  steps: [
    { kind: "warmup", end: time(600), target: hr(1) },
    {
      kind: "repeat",
      times: 5,
      steps: [
        { kind: "work", end: time(180), target: hr(4) },
        { kind: "recovery", end: time(120), target: hr(1) },
      ],
    },
    { kind: "cooldown", end: time(600), target: hr(1) },
  ],
};

// HR + repeat text verified live (spike S1); other constructs are unverified live.
const SPIKE_TEXT =
  "Warmup\n- 10m Z1 HR\n\nMain set 5x\n- 3m Z4 HR\n- 2m Z1 HR\n\nCooldown\n- 10m Z1 HR";

const issues = (input: unknown) => {
  const r = validateWorkout(input);
  if (r.ok) throw new Error("expected invalid");
  return r.issues;
};
const withSteps = (steps: unknown[]) => ({ ...spikeWorkout, steps });
const one = (step: Record<string, unknown>) =>
  withSteps([{ kind: "work", end: time(60), target: hr(2), ...step }]);

describe("toIntervalsText golden", () => {
  it("matches the verified spike text", () => {
    expect(toIntervalsText(parseWorkout(spikeWorkout))).toBe(SPIKE_TEXT);
  });

  it("formats times", () => {
    const t = (s: number) => toIntervalsText(parseWorkout(one({ end: time(s) })));
    expect(t(30)).toBe("Work\n- 30s Z2 HR");
    expect(t(90)).toBe("Work\n- 1m30 Z2 HR");
    expect(t(65)).toBe("Work\n- 1m05 Z2 HR");
    expect(t(3600)).toBe("Work\n- 60m Z2 HR");
  });

  it("formats distances", () => {
    const d = (meters: number) =>
      toIntervalsText(parseWorkout(one({ end: { type: "distance", meters } })));
    expect(d(1000)).toBe("Work\n- 1km Z2 HR");
    expect(d(3000)).toBe("Work\n- 3km Z2 HR");
    expect(d(400)).toBe("Work\n- 400mtr Z2 HR");
  });

  it("formats pace, slowest first", () => {
    const w = one({
      kind: "recovery",
      target: { type: "pace", fastSecPerKm: 300, slowSecPerKm: 325 },
    });
    expect(toIntervalsText(parseWorkout(w))).toBe("Recovery\n- 1m 5:25-5:00/km Pace");
  });

  it("formats power", () => {
    const w = (unit: string) =>
      toIntervalsText(parseWorkout(one({ target: { type: "power", unit, min: 100, max: 140 } })));
    expect(w("watts")).toBe("Work\n- 1m 100-140w");
    expect(w("percent_ftp")).toBe("Work\n- 1m 100-140%");
  });

  it("is deterministic and does not mutate", () => {
    const w = parseWorkout(spikeWorkout);
    const snapshot = JSON.stringify(w);
    const outs = new Set(Array.from({ length: 20 }, () => toIntervalsText(w)));
    expect(outs.size).toBe(1);
    expect(JSON.stringify(w)).toBe(snapshot);
  });

  it("emits only known tokens for any valid generated workout", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed % n) + 1;
    };
    let unit = "watts";
    const targets = [
      () => hr(rnd(5)),
      () => ({ type: "pace", fastSecPerKm: 120 + rnd(100), slowSecPerKm: 400 + rnd(100) }),
      () => ({
        type: "power",
        unit,
        min: rnd(100),
        max: 100 + rnd(100),
      }),
    ];
    for (let i = 0; i < 200; i++) {
      unit = rnd(2) === 1 ? "watts" : "percent_ftp";
      const makeTarget = targets[rnd(3) - 1] ?? targets[0];
      const steps = Array.from({ length: rnd(5) }, () => ({
        kind: "work",
        end: rnd(2) === 1 ? time(rnd(20000)) : { type: "distance", meters: rnd(90000) },
        target: makeTarget?.(),
      }));
      const text = toIntervalsText(parseWorkout(withSteps(steps)));
      const again = toIntervalsText(parseWorkout(withSteps(steps)));
      expect(text).toBe(again);
      for (const line of text.split("\n").filter((l) => l !== "" && l !== "Work")) {
        expect(line).toMatch(
          /^- \d+(s|m|m\d\d|km|mtr) (Z[1-5] HR|\d+:\d\d-\d+:\d\d\/km Pace|\d+-\d+(w|%))$/,
        );
      }
    }
  });
});

describe("validation", () => {
  it("accepts the spike workout", () => {
    expect(validateWorkout(spikeWorkout)).toEqual({ ok: true, workout: spikeWorkout });
  });

  it("rejects mixed target types with an actionable message", () => {
    const w = withSteps([
      { kind: "warmup", end: time(60), target: hr(1) },
      {
        kind: "work",
        end: time(60),
        target: { type: "pace", fastSecPerKm: 300, slowSecPerKm: 320 },
      },
    ]);
    expect(issues(w)).toEqual([
      {
        path: "steps[1].target",
        message: "step 2 uses pace but step 1 uses heart rate; a workout must use one target type",
      },
    ]);
  });

  it("rejects mixed target types inside repeats", () => {
    const w = withSteps([
      { kind: "warmup", end: time(60), target: { type: "power", unit: "watts", min: 1, max: 2 } },
      { kind: "repeat", times: 2, steps: [{ kind: "work", end: time(60), target: hr(3) }] },
    ]);
    expect(issues(w)[0]).toEqual({
      path: "steps[1].steps[0].target",
      message: "step 2.1 uses heart rate but step 1 uses power; a workout must use one target type",
    });
  });

  it("rejects mixed power units with an actionable message", () => {
    const power = (unit: string) => ({ type: "power", unit, min: 50, max: 100 });
    const w = withSteps([
      { kind: "warmup", end: time(60), target: power("watts") },
      {
        kind: "repeat",
        times: 2,
        steps: [{ kind: "work", end: time(60), target: power("percent_ftp") }],
      },
      { kind: "cooldown", end: time(60), target: power("watts") },
    ]);
    expect(issues(w)).toEqual([
      {
        path: "steps[1].steps[0].target.unit",
        message: "step 2.1 uses %FTP but step 1 uses watts; a workout must use one power unit",
      },
    ]);
    expect(() => toIntervalsText(w as never)).toThrow(/one power unit/);
  });

  it("rejects nested repeats and warmups inside repeats", () => {
    const nested = withSteps([
      { kind: "repeat", times: 2, steps: [{ kind: "repeat", times: 2, steps: [] }] },
    ]);
    expect(issues(nested)[0]?.path).toBe("steps[0].steps[0].kind");
    expect(issues(nested)[0]?.message).toBe("steps inside a repeat must be work or recovery");
    const warm = withSteps([
      { kind: "repeat", times: 2, steps: [{ kind: "warmup", end: time(60), target: hr(1) }] },
    ]);
    expect(issues(warm)[0]?.message).toBe("steps inside a repeat must be work or recovery");
  });

  it("requires a target on every step", () => {
    const w = withSteps([{ kind: "work", end: time(60) }]);
    expect(issues(w)[0]).toEqual({
      path: "steps[0].target",
      message: "every step needs a target; target.type must be hr, pace or power",
    });
  });

  it("rejects unverified/unknown constructs", () => {
    expect(
      issues(one({ target: { type: "hr", bpmMin: 120, bpmMax: 140 } })).length,
    ).toBeGreaterThan(0);
    expect(issues(one({ end: { type: "lap" } }))[0]?.path).toBe("steps[0].end.type");
    expect(issues(one({ kind: "ramp" }))[0]?.message).toContain("step kind must be");
    expect(issues({ ...spikeWorkout, sport: "ride" })[0]?.message).toBe('sport must be "run"');
    expect(issues({ ...spikeWorkout, extra: 1 }).length).toBe(1);
  });

  it("rejects non-objects and structural errors", () => {
    expect(issues(null)[0]?.path).toBe("workout");
    expect(issues({ ...spikeWorkout, steps: [] })[0]?.message).toBe(
      "a workout needs at least one step",
    );
    expect(issues({ ...spikeWorkout, steps: "x" })[0]?.message).toBe("steps must be a list");
    expect(issues(withSteps([{ kind: "repeat", times: 2, steps: [] }]))[0]?.message).toBe(
      "a repeat needs at least one step",
    );
    expect(issues(withSteps(["x"]))[0]?.message).toContain("step kind must be");
  });

  describe("boundaries", () => {
    const ok = (w: unknown) => expect(validateWorkout(w).ok).toBe(true);
    const bad = (w: unknown, msg: string) => expect(issues(w)[0]?.message).toBe(msg);
    const rep = (times: number, n = 1) =>
      withSteps([
        {
          kind: "repeat",
          times,
          steps: Array.from({ length: n }, () => ({ kind: "work", end: time(60), target: hr(1) })),
        },
      ]);

    it("repeat times 1..100", () => {
      ok(rep(1));
      ok(rep(100));
      bad(rep(0), "repeat count must be between 1 and 100");
      bad(rep(101), "repeat count must be between 1 and 100");
      bad(rep(1.5), "repeat count must be a whole number");
      bad(withSteps([{ kind: "repeat", times: "5", steps: [] }]), "repeat count must be a number");
    });

    it("repeat and top-level step counts", () => {
      ok(rep(2, 10));
      bad(rep(2, 11), "a repeat can have at most 10 steps");
      ok(
        withSteps(
          Array.from({ length: 50 }, () => ({ kind: "work", end: time(60), target: hr(1) })),
        ),
      );
      bad(
        withSteps(
          Array.from({ length: 51 }, () => ({ kind: "work", end: time(60), target: hr(1) })),
        ),
        "a workout can have at most 50 steps",
      );
    });

    it("durations and distances", () => {
      ok(one({ end: time(1) }));
      ok(one({ end: time(21600) }));
      bad(one({ end: time(0) }), "duration must be at least 1 second");
      bad(one({ end: time(21601) }), "duration must be at most 21600 seconds");
      ok(one({ end: { type: "distance", meters: 100000 } }));
      bad(one({ end: { type: "distance", meters: 0 } }), "distance must be at least 1 meter");
      bad(
        one({ end: { type: "distance", meters: 100001 } }),
        "distance must be at most 100000 meters",
      );
      bad(one({ end: time(Number.NaN) }), "duration must be a number");
    });

    it("targets", () => {
      ok(one({ target: hr(1) }));
      ok(one({ target: hr(5) }));
      bad(one({ target: hr(0) }), "heart rate zone must be between 1 and 5");
      bad(one({ target: hr(6) }), "heart rate zone must be between 1 and 5");
      const pace = (fast: number, slow: number) =>
        one({ target: { type: "pace", fastSecPerKm: fast, slowSecPerKm: slow } });
      ok(pace(120, 1200));
      ok(pace(300, 300));
      bad(pace(119, 300), "pace must be at least 120 seconds per km");
      bad(pace(300, 1201), "pace must be at most 1200 seconds per km");
      bad(
        pace(320, 300),
        "fast pace must not be slower than slow pace (fastSecPerKm <= slowSecPerKm)",
      );
      const pw = (unit: string, min: number, max: number) =>
        one({ target: { type: "power", unit, min, max } });
      ok(pw("watts", 1, 2000));
      ok(pw("percent_ftp", 1, 300));
      bad(pw("watts", 1, 2001), "power maximum must be at most 2000 watts");
      bad(pw("percent_ftp", 1, 301), "power maximum must be at most 300 percent_ftp");
      bad(pw("watts", 200, 100), "power minimum must not exceed maximum");
      bad(pw("watts", 0, 100), "power minimum must be at least 1");
      bad(pw("bpm", 1, 2), "power unit must be watts or percent_ftp");
    });

    it("name", () => {
      ok({ ...spikeWorkout, name: "a".repeat(100) });
      bad({ ...spikeWorkout, name: "a".repeat(101) }, "name must be at most 100 characters");
      bad({ ...spikeWorkout, name: "" }, "name must not be empty");
      bad({ ...spikeWorkout, name: "   " }, "name must not be blank");
      bad({ ...spikeWorkout, name: 5 }, "name must be a string");
    });
  });

  describe("injection", () => {
    const attempts = [
      "a\n- 10m Z1 HR",
      "a\r\nMain set 99x",
      "a\u0000b",
      "a b",
      "a b",
      "a\tb",
      "a\u0085b",
    ];
    it.each(attempts)("rejects name %j", (name) => {
      expect(issues({ ...spikeWorkout, name })[0]?.message).toBe(
        "name must not contain control characters or line breaks",
      );
    });

    it("never copies names into the text", () => {
      const name = "- 10m Z9 HR 99x Main set";
      const text = toIntervalsText(parseWorkout({ ...spikeWorkout, name }));
      expect(text).toBe(SPIKE_TEXT);
    });

    it("rejects string-typed numerics that could smuggle tokens", () => {
      expect(issues(one({ end: { type: "time", seconds: "60\n- 1m Z9 HR" } }))[0]?.message).toBe(
        "duration must be a number",
      );
      expect(issues(one({ target: { type: "hr", zone: "1 HR\n- 5m" } }))[0]?.message).toBe(
        "heart rate zone must be a number",
      );
    });
  });
});

describe("parseWorkout and workoutTargetType", () => {
  it("throws WorkoutValidationError with issues", () => {
    expect(() => parseWorkout({})).toThrow(WorkoutValidationError);
    try {
      parseWorkout(null);
    } catch (e) {
      expect((e as WorkoutValidationError).issues[0]?.path).toBe("workout");
      expect((e as Error).message).toContain("Invalid workout:");
    }
  });

  it("derives the target type", () => {
    expect(workoutTargetType(parseWorkout(spikeWorkout))).toBe("hr");
    const first = withSteps([
      { kind: "work", end: time(60), target: { type: "power", unit: "watts", min: 1, max: 2 } },
    ]);
    expect(workoutTargetType(parseWorkout(first))).toBe("power");
    const rep = withSteps([
      { kind: "repeat", times: 2, steps: [{ kind: "work", end: time(60), target: hr(1) }] },
    ]);
    expect(workoutTargetType(parseWorkout(rep))).toBe("hr");
    expect(() => workoutTargetType({ name: "x", sport: "run", steps: [] })).toThrow(
      WorkoutValidationError,
    );
  });
});

describe("adversarial: serialisation boundaries", () => {
  const text = (step: Record<string, unknown>) => toIntervalsText(parseWorkout(one(step)));

  it.each([
    [1, "1s"],
    [59, "59s"],
    [60, "1m"],
    [61, "1m01"],
    [65, "1m05"],
    [3599, "59m59"],
    [3600, "60m"],
    [5400, "90m"],
    [21600, "360m"],
  ])("formats %is as %s", (seconds, expected) => {
    expect(text({ end: time(seconds) })).toBe(`Work\n- ${expected} Z2 HR`);
  });

  it.each([
    [1, "1mtr"],
    [999, "999mtr"],
    [1000, "1km"],
    [1001, "1001mtr"],
    [1500, "1500mtr"],
    [100000, "100km"],
  ])("formats %im as %s", (meters, expected) => {
    expect(text({ end: { type: "distance", meters } })).toBe(`Work\n- ${expected} Z2 HR`);
  });

  it.each([
    [305, 305, "5:05-5:05"],
    [120, 1200, "20:00-2:00"],
    [599, 600, "10:00-9:59"],
    [300, 300, "5:00-5:00"],
  ])("formats pace fast=%i slow=%i as %s", (fast, slow, expected) => {
    expect(text({ target: { type: "pace", fastSecPerKm: fast, slowSecPerKm: slow } })).toBe(
      `Work\n- 1m ${expected}/km Pace`,
    );
  });

  it("emits every section type and ends without a trailing newline", () => {
    const out = toIntervalsText(
      parseWorkout(
        withSteps([
          { kind: "recovery", end: time(30), target: hr(1) },
          { kind: "work", end: time(30), target: hr(3) },
        ]),
      ),
    );
    expect(out).toBe("Recovery\n- 30s Z1 HR\n\nWork\n- 30s Z3 HR");
  });

  it("renders a distance-based repeat and every repeat times boundary", () => {
    const rep = (times: number) =>
      toIntervalsText(
        parseWorkout(
          withSteps([
            {
              kind: "repeat",
              times,
              steps: [{ kind: "work", end: { type: "distance", meters: 400 }, target: hr(4) }],
            },
          ]),
        ),
      );
    expect(rep(1)).toBe("Main set 1x\n- 400mtr Z4 HR");
    expect(rep(100)).toBe("Main set 100x\n- 400mtr Z4 HR");
  });
});

describe("adversarial: toIntervalsText never trusts its input", () => {
  const corrupt = (path: (string | number)[], value: unknown): Workout => {
    const w: unknown = JSON.parse(JSON.stringify(spikeWorkout));
    let node = w as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
    node[path[path.length - 1] as string | number] = value;
    return w as Workout;
  };
  it.each([
    ["NaN seconds", ["steps", 0, "end", "seconds"], Number.NaN],
    ["Infinity seconds", ["steps", 0, "end", "seconds"], Number.POSITIVE_INFINITY],
    ["float seconds", ["steps", 0, "end", "seconds"], 90.5],
    ["string seconds with injected line", ["steps", 0, "end", "seconds"], "60\n- 1m Z9 HR"],
    ["string zone with injected line", ["steps", 0, "target", "zone"], "1 HR\n- 5m"],
    ["string repeat count", ["steps", 1, "times"], "9x\n- evil"],
    ["newline in step kind", ["steps", 0, "kind"], "warmup\n- 1m Z9 HR"],
    ["empty repeat", ["steps", 1, "steps"], []],
    ["unknown target type", ["steps", 0, "target", "type"], "cadence"],
  ] as [string, (string | number)[], unknown][])(
    "throws instead of emitting text for %s",
    (_label, path, value) => {
      expect(() => toIntervalsText(corrupt(path, value))).toThrow(WorkoutValidationError);
    },
  );

  it("throws on mixed target types in a hand-built workout", () => {
    const w = corrupt(["steps", 0, "target"], { type: "power", unit: "watts", min: 100, max: 200 });
    expect(() => toIntervalsText(w)).toThrow(/one target type/);
  });
});

describe("adversarial: validation gaps", () => {
  const bad = (w: unknown) => issues(w);
  const msgs = (w: unknown) => bad(w).map((i) => i.message);

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["array", []],
    ["array of workouts", [spikeWorkout]],
    ["string", "run"],
    ["number", 5],
    ["boolean", true],
  ])("rejects a %s root with path 'workout'", (_l, input) => {
    const r = bad(input);
    expect(r).toHaveLength(1);
    expect(r[0]?.path).toBe("workout");
  });

  it("rejects missing required fields with precise paths", () => {
    expect(
      bad({})
        .map((i) => i.path)
        .sort(),
    ).toEqual(["name", "sport", "steps"]);
  });

  it("rejects negative, zero and bigint durations and distances", () => {
    expect(msgs(one({ end: time(-5) }))).toEqual(["duration must be at least 1 second"]);
    expect(msgs(one({ end: time(-0) }))).toEqual(["duration must be at least 1 second"]);
    expect(msgs(one({ end: time(Number.POSITIVE_INFINITY) }))).toEqual([
      "duration must be a number",
    ]);
    expect(msgs(one({ end: time(1e21) }))).toContain("duration must be at most 21600 seconds");
    expect(msgs(one({ end: time(90.5) }))).toEqual(["duration must be a whole number"]);
    expect(msgs(one({ end: { type: "time", seconds: 10n } }))).toEqual([
      "duration must be a number",
    ]);
    expect(msgs(one({ end: { type: "distance", meters: 0.1 } }))).toContain(
      "distance must be a whole number",
    );
    expect(msgs(one({ end: { type: "distance", meters: -1 } }))).toEqual([
      "distance must be at least 1 meter",
    ]);
  });

  it("rejects a step with both end types", () => {
    const r = bad(one({ end: { type: "time", seconds: 60, meters: 100 } }));
    expect(r).toHaveLength(1);
    expect(r[0]?.path).toBe("steps[0].end");
  });

  it("rejects missing end", () => {
    expect(bad(withSteps([{ kind: "work", target: hr(1) }]))[0]).toEqual({
      path: "steps[0].end",
      message: "end.type must be time or distance",
    });
  });

  it("rejects non-integer, out-of-range and equal-but-valid pace edges", () => {
    const pace = (fast: unknown, slow: unknown) =>
      one({ target: { type: "pace", fastSecPerKm: fast, slowSecPerKm: slow } });
    expect(msgs(pace(0, 300))).toEqual(["pace must be at least 120 seconds per km"]);
    expect(msgs(pace(59, 300))).toEqual(["pace must be at least 120 seconds per km"]);
    expect(msgs(pace(300, 1800))).toEqual(["pace must be at most 1200 seconds per km"]);
    expect(msgs(pace(300.5, 400))).toEqual(["fast pace (seconds per km) must be a whole number"]);
    expect(msgs(pace(300, "400"))).toEqual(["slow pace (seconds per km) must be a number"]);
    expect(bad(pace(400, 300))[0]?.path).toBe("steps[0].target");
  });

  it("rejects bad heart rate zones", () => {
    expect(msgs(one({ target: hr(2.5) }))).toEqual(["heart rate zone must be a whole number"]);
    expect(msgs(one({ target: hr(-1) }))).toEqual(["heart rate zone must be between 1 and 5"]);
    expect(msgs(one({ target: { type: "hr" } }))).toEqual(["heart rate zone must be a number"]);
  });

  it("accepts a power range with equal minimum and maximum", () => {
    const w = one({ target: { type: "power", unit: "watts", min: 150, max: 150 } });
    expect(toIntervalsText(parseWorkout(w))).toBe("Work\n- 1m 150-150w");
  });

  it("rejects bad power ranges, reporting every problem", () => {
    const pw = (unit: string, min: number, max: number) =>
      one({ target: { type: "power", unit, min, max } });
    expect(msgs(pw("watts", -5, 100))).toEqual(["power minimum must be at least 1"]);
    expect(msgs(pw("watts", 5000, 4000))).toEqual([
      "power minimum must not exceed maximum",
      "power maximum must be at most 2000 watts",
    ]);
    expect(msgs(pw("percent_ftp", 250, 201 + 100))).toEqual([
      "power maximum must be at most 300 percent_ftp",
    ]);
    expect(msgs(pw("watts", 100.5, 200))).toEqual(["power minimum must be a whole number"]);
  });

  it("rejects 0 inner steps, 11 inner steps and 51 top-level steps with the right path", () => {
    const inner = (n: number) =>
      withSteps([
        {
          kind: "repeat",
          times: 2,
          steps: Array.from({ length: n }, () => ({ kind: "work", end: time(60), target: hr(1) })),
        },
      ]);
    expect(bad(inner(0))[0]?.path).toBe("steps[0].steps");
    expect(bad(inner(11))[0]?.path).toBe("steps[0].steps");
    expect(bad(withSteps([]))[0]?.path).toBe("steps");
  });

  it("rejects a repeat inside a repeat and reports the path of the nested step", () => {
    const nested = withSteps([
      {
        kind: "repeat",
        times: 2,
        steps: [
          { kind: "work", end: time(60), target: hr(1) },
          { kind: "repeat", times: 2, steps: [] },
        ],
      },
    ]);
    expect(bad(nested)[0]?.path).toBe("steps[0].steps[1].kind");
  });

  it("reports mixed targets for every deviating step, including pace vs power across repeats", () => {
    const pace = { type: "pace", fastSecPerKm: 300, slowSecPerKm: 320 };
    const power = { type: "power", unit: "watts", min: 100, max: 200 };
    const w = withSteps([
      { kind: "warmup", end: time(60), target: pace },
      {
        kind: "repeat",
        times: 2,
        steps: [
          { kind: "work", end: time(60), target: pace },
          { kind: "recovery", end: time(60), target: power },
        ],
      },
      { kind: "cooldown", end: time(60), target: hr(1) },
    ]);
    expect(bad(w).map((i) => i.path)).toEqual(["steps[1].steps[1].target", "steps[2].target"]);
  });

  it("accepts the same target type across nested repeats", () => {
    const power = { type: "power", unit: "percent_ftp", min: 80, max: 90 };
    const w = withSteps([
      { kind: "warmup", end: time(60), target: power },
      { kind: "repeat", times: 3, steps: [{ kind: "work", end: time(60), target: power }] },
    ]);
    expect(validateWorkout(w).ok).toBe(true);
  });

  it("rejects unknown keys at every level", () => {
    expect(bad({ ...spikeWorkout, extra: 1 })[0]?.path).toBe("workout");
    expect(bad(one({ extra: 1 }))[0]?.path).toBe("steps[0]");
    expect(bad(one({ target: { type: "hr", zone: 1, extra: 1 } }))[0]?.path).toBe(
      "steps[0].target",
    );
    expect(
      bad(withSteps([{ kind: "repeat", times: 2, extra: 1, steps: [] }])).some(
        (i) => i.path === "steps[0]",
      ),
    ).toBe(true);
  });

  it("treats __proto__ and constructor keys as unknown fields, not as pollution", () => {
    const polluted = JSON.parse('{"name":"n","sport":"run","__proto__":{"x":1},"steps":[]}');
    expect(bad(polluted).some((i) => i.message.includes("__proto__"))).toBe(true);
    expect(msgs(one({ constructor: 1 }))[0]).toContain("constructor");
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("treats array holes as invalid steps and reads getters once as plain data", () => {
    // biome-ignore lint/suspicious/noSparseArray: deliberately sparse
    expect(bad(withSteps([, { kind: "work", end: time(60), target: hr(1) }]))[0]?.path).toBe(
      "steps[0]",
    );
    const getter = {
      kind: "work",
      get end() {
        return time(60);
      },
      target: hr(1),
    };
    const r = validateWorkout(withSteps([getter]));
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(Object.getOwnPropertyDescriptor(r.workout.steps[0], "end")?.get).toBeUndefined();
  });

  it("rejects names with Unicode line and paragraph separators", () => {
    expect(msgs({ ...spikeWorkout, name: "a b" })).toEqual([
      "name must not contain control characters or line breaks",
    ]);
    expect(msgs({ ...spikeWorkout, name: "a b" })).toEqual([
      "name must not contain control characters or line breaks",
    ]);
  });
});

describe("adversarial: message quality", () => {
  const huge = "Z".repeat(10_000);

  it("never echoes huge user values or keys, and keeps messages short", () => {
    const attacks: unknown[] = [
      { ...spikeWorkout, name: huge },
      { ...spikeWorkout, sport: huge },
      { ...spikeWorkout, [huge]: 1 },
      withSteps([{ kind: huge }]),
      one({ [huge]: 1 }),
      one({ end: { type: huge } }),
      one({ end: { type: "time", seconds: huge } }),
      one({ target: { type: huge } }),
      one({ target: { type: "hr", zone: huge } }),
      one({ target: { type: "power", unit: huge, min: 1, max: 2 } }),
      withSteps([{ kind: "repeat", times: huge, steps: huge }]),
      withSteps(huge as never),
    ];
    for (const attack of attacks) {
      for (const issue of issues(attack)) {
        expect(issue.message).not.toContain("ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ");
        expect(issue.message.length).toBeLessThan(200);
        expect(issue.path.length).toBeLessThan(100);
      }
    }
  });

  it("names unknown fields (capped) and tells the caller what to do", () => {
    expect(issues(one({ colour: "red" }))).toEqual([
      { path: "steps[0]", message: 'unknown field(s) "colour"; remove them' },
    ]);
    const many = issues({ ...spikeWorkout, a: 1, b: 2, c: 3, d: 4, e: 5 });
    expect(many[0]?.message).toBe('unknown field(s) "a", "b", "c" and 2 more; remove them');
    const long = issues({ ...spikeWorkout, ["k".repeat(100)]: 1 });
    expect(long[0]?.message).toBe(`unknown field(s) "${"k".repeat(30)}..."; remove them`);
  });

  it("escapes control characters in unknown keys so messages stay single-line", () => {
    const m = issues({ ...spikeWorkout, "a\nb": 1 })[0]?.message ?? "";
    expect(m).not.toContain("\n");
  });

  it("reports several independent problems with distinct precise paths", () => {
    const r = issues({
      name: "",
      sport: "ride",
      steps: [{ kind: "work", end: time(0), target: hr(9) }],
    });
    expect(r.map((i) => i.path).sort()).toEqual([
      "name",
      "sport",
      "steps[0].end.seconds",
      "steps[0].target.zone",
    ]);
  });

  it("WorkoutValidationError message joins path and message", () => {
    try {
      parseWorkout({ ...spikeWorkout, name: "" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("Invalid workout: name: name must not be empty");
      expect((e as Error).name).toBe("WorkoutValidationError");
    }
  });
});

describe("adversarial: purity and determinism", () => {
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === "object") {
      for (const v of Object.values(o)) deepFreeze(v);
      Object.freeze(o);
    }
    return o;
  };

  it("accepts deeply frozen input, does not mutate it, and returns an independent copy", () => {
    const input = deepFreeze(JSON.parse(JSON.stringify(spikeWorkout)));
    const before = JSON.stringify(input);
    const r = validateWorkout(input);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    if (r.ok) {
      expect(r.workout).not.toBe(input);
      expect(r.workout.steps).not.toBe(input.steps);
      expect(Object.isFrozen(r.workout)).toBe(false);
    }
    expect(toIntervalsText(parseWorkout(input))).toBe(SPIKE_TEXT);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("does not mutate input on failure either", () => {
    const input = deepFreeze(JSON.parse(JSON.stringify({ ...spikeWorkout, name: "" })));
    const before = JSON.stringify(input);
    expect(validateWorkout(input).ok).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("produces identical text regardless of object key order", () => {
    const reversed = (o: unknown): unknown =>
      Array.isArray(o)
        ? o.map(reversed)
        : o && typeof o === "object"
          ? Object.fromEntries(
              Object.entries(o)
                .reverse()
                .map(([k, v]) => [k, reversed(v)]),
            )
          : o;
    expect(toIntervalsText(parseWorkout(reversed(spikeWorkout)))).toBe(SPIKE_TEXT);
  });

  it("gives the same validation issues for repeated calls", () => {
    const bad = { ...spikeWorkout, name: "", steps: [] };
    expect(validateWorkout(bad)).toEqual(validateWorkout(bad));
  });
});

describe("adversarial: workoutTargetType", () => {
  it("throws instead of inventing a type for a repeat with no steps", () => {
    const w = { name: "x", sport: "run", steps: [{ kind: "repeat", times: 2, steps: [] }] };
    expect(() => workoutTargetType(w as never)).toThrow(WorkoutValidationError);
    try {
      workoutTargetType(w as never);
    } catch (e) {
      expect((e as WorkoutValidationError).issues[0]?.path).toBe("steps[0].steps");
    }
  });

  it("reports pace for a pace workout", () => {
    const w = one({ target: { type: "pace", fastSecPerKm: 300, slowSecPerKm: 310 } });
    expect(workoutTargetType(parseWorkout(w))).toBe("pace");
  });
});
