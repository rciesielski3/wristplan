import { z } from "zod";

export const LIMITS = {
  nameMaxLength: 100,
  maxTopLevelSteps: 50,
  maxRepeatSteps: 10,
  maxRepeatTimes: 100,
  maxSeconds: 6 * 3600,
  maxMeters: 100_000,
  paceSecPerKm: { min: 120, max: 1200 },
  maxWatts: 2000,
  maxPercentFtp: 300,
} as const;

const int = (label: string) =>
  z.number({ error: `${label} must be a number` }).int(`${label} must be a whole number`);

const hrTarget = z.strictObject({
  type: z.literal("hr"),
  zone: int("heart rate zone")
    .min(1, "heart rate zone must be between 1 and 5")
    .max(5, "heart rate zone must be between 1 and 5"),
});

const paceTarget = z
  .strictObject({
    type: z.literal("pace"),
    fastSecPerKm: int("fast pace (seconds per km)")
      .min(
        LIMITS.paceSecPerKm.min,
        `pace must be at least ${LIMITS.paceSecPerKm.min} seconds per km`,
      )
      .max(
        LIMITS.paceSecPerKm.max,
        `pace must be at most ${LIMITS.paceSecPerKm.max} seconds per km`,
      ),
    slowSecPerKm: int("slow pace (seconds per km)")
      .min(
        LIMITS.paceSecPerKm.min,
        `pace must be at least ${LIMITS.paceSecPerKm.min} seconds per km`,
      )
      .max(
        LIMITS.paceSecPerKm.max,
        `pace must be at most ${LIMITS.paceSecPerKm.max} seconds per km`,
      ),
  })
  .refine((t) => t.fastSecPerKm <= t.slowSecPerKm, {
    error: "fast pace must not be slower than slow pace (fastSecPerKm <= slowSecPerKm)",
  });

const powerTarget = z
  .strictObject({
    type: z.literal("power"),
    unit: z.enum(["watts", "percent_ftp"], { error: "power unit must be watts or percent_ftp" }),
    min: int("power minimum").min(1, "power minimum must be at least 1"),
    max: int("power maximum").min(1, "power maximum must be at least 1"),
  })
  .superRefine((t, ctx) => {
    const cap = t.unit === "watts" ? LIMITS.maxWatts : LIMITS.maxPercentFtp;
    if (t.min > t.max)
      ctx.addIssue({ code: "custom", message: "power minimum must not exceed maximum" });
    if (t.max > cap)
      ctx.addIssue({ code: "custom", message: `power maximum must be at most ${cap} ${t.unit}` });
  });

const target = z.discriminatedUnion("type", [hrTarget, paceTarget, powerTarget], {
  error: "every step needs a target; target.type must be hr, pace or power",
});

const timeEnd = z.strictObject({
  type: z.literal("time"),
  seconds: int("duration")
    .min(1, "duration must be at least 1 second")
    .max(LIMITS.maxSeconds, `duration must be at most ${LIMITS.maxSeconds} seconds`),
});

const distanceEnd = z.strictObject({
  type: z.literal("distance"),
  meters: int("distance")
    .min(1, "distance must be at least 1 meter")
    .max(LIMITS.maxMeters, `distance must be at most ${LIMITS.maxMeters} meters`),
});

const end = z.discriminatedUnion("type", [timeEnd, distanceEnd], {
  error: "end.type must be time or distance",
});

const stepShape = { end, target };

const repeatStep = z.strictObject({
  kind: z.enum(["work", "recovery"], { error: "steps inside a repeat must be work or recovery" }),
  ...stepShape,
});

const topStep = z.strictObject({
  kind: z.enum(["warmup", "work", "recovery", "cooldown"], {
    error: "step kind must be warmup, work, recovery, cooldown or repeat",
  }),
  ...stepShape,
});

const repeat = z.strictObject({
  kind: z.literal("repeat"),
  times: int("repeat count")
    .min(1, "repeat count must be between 1 and 100")
    .max(LIMITS.maxRepeatTimes, "repeat count must be between 1 and 100"),
  steps: z
    .array(repeatStep, { error: "repeat steps must be a list" })
    .min(1, "a repeat needs at least one step")
    .max(LIMITS.maxRepeatSteps, `a repeat can have at most ${LIMITS.maxRepeatSteps} steps`),
});

const step = z.discriminatedUnion("kind", [repeat, topStep], {
  error: "step kind must be warmup, work, recovery, cooldown or repeat",
});

const name = z
  .string({ error: "name must be a string" })
  .min(1, { error: "name must not be empty", abort: true })
  .max(LIMITS.nameMaxLength, `name must be at most ${LIMITS.nameMaxLength} characters`)
  .refine((n) => n.trim().length > 0, { error: "name must not be blank" })
  .refine((n) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(n), {
    error: "name must not contain control characters or line breaks",
  });

export const workoutSchema = z.strictObject({
  name,
  sport: z.literal("run", { error: 'sport must be "run"' }),
  steps: z
    .array(step, { error: "steps must be a list" })
    .min(1, "a workout needs at least one step")
    .max(LIMITS.maxTopLevelSteps, `a workout can have at most ${LIMITS.maxTopLevelSteps} steps`),
});

export type Target = z.infer<typeof target>;
export type End = z.infer<typeof end>;
export type Step = z.infer<typeof topStep>;
export type RepeatStep = z.infer<typeof repeatStep>;
export type Repeat = z.infer<typeof repeat>;
export type Workout = z.infer<typeof workoutSchema>;
export type TargetType = Target["type"];
