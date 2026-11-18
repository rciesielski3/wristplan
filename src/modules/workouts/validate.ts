import { type TargetType, type Workout, workoutSchema } from "./model";

export interface WorkoutIssue {
  readonly path: string;
  readonly message: string;
}

export type WorkoutResult =
  | { readonly ok: true; readonly workout: Workout }
  | { readonly ok: false; readonly issues: readonly WorkoutIssue[] };

export class WorkoutValidationError extends Error {
  override readonly name = "WorkoutValidationError";
  constructor(readonly issues: readonly WorkoutIssue[]) {
    super(`Invalid workout: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
}

const TARGET_LABEL: Record<TargetType, string> = {
  hr: "heart rate",
  pace: "pace",
  power: "power",
};

const UNIT_LABEL = { watts: "watts", percent_ftp: "%FTP" } as const;

const formatPath = (path: readonly PropertyKey[]): string =>
  path.reduce<string>(
    (acc, seg) =>
      typeof seg === "number" ? `${acc}[${seg}]` : acc ? `${acc}.${String(seg)}` : String(seg),
    "",
  ) || "workout";

const mixedTargetIssues = (workout: Workout): WorkoutIssue[] => {
  const labelled = workout.steps.flatMap((s, i) =>
    s.kind === "repeat"
      ? s.steps.map((inner, j) => ({
          label: `step ${i + 1}.${j + 1}`,
          path: `steps[${i}].steps[${j}].target`,
          type: inner.target.type,
          unit: inner.target.type === "power" ? inner.target.unit : undefined,
        }))
      : [
          {
            label: `step ${i + 1}`,
            path: `steps[${i}].target`,
            type: s.target.type,
            unit: s.target.type === "power" ? s.target.unit : undefined,
          },
        ],
  );
  const first = labelled[0];
  const firstPower = labelled.find((t) => t.unit !== undefined);
  return labelled.flatMap((t) => {
    const issues: WorkoutIssue[] = [];
    if (first && t.type !== first.type)
      issues.push({
        path: t.path,
        message: `${t.label} uses ${TARGET_LABEL[t.type]} but ${first.label} uses ${TARGET_LABEL[first.type]}; a workout must use one target type`,
      });
    if (firstPower?.unit && t.unit && t.unit !== firstPower.unit)
      issues.push({
        path: `${t.path}.unit`,
        message: `${t.label} uses ${UNIT_LABEL[t.unit]} but ${firstPower.label} uses ${UNIT_LABEL[firstPower.unit]}; a workout must use one power unit`,
      });
    return issues;
  });
};

const MAX_KEYS_SHOWN = 3;
const MAX_KEY_LENGTH = 30;

// Zod echoes unknown keys verbatim; user-controlled keys can be huge or contain control characters.
const unknownKeysMessage = (keys: readonly string[]): string => {
  const shown = keys
    .slice(0, MAX_KEYS_SHOWN)
    .map((k) => JSON.stringify(k.length > MAX_KEY_LENGTH ? `${k.slice(0, MAX_KEY_LENGTH)}...` : k));
  const more = keys.length > MAX_KEYS_SHOWN ? ` and ${keys.length - MAX_KEYS_SHOWN} more` : "";
  return `unknown field(s) ${shown.join(", ")}${more}; remove them`;
};

export const validateWorkout = (input: unknown): WorkoutResult => {
  const parsed = workoutSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: formatPath(i.path),
        message: i.code === "unrecognized_keys" ? unknownKeysMessage(i.keys) : i.message,
      })),
    };
  }
  const issues = mixedTargetIssues(parsed.data);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, workout: parsed.data };
};

export const parseWorkout = (input: unknown): Workout => {
  const result = validateWorkout(input);
  if (!result.ok) throw new WorkoutValidationError(result.issues);
  return result.workout;
};

export const workoutTargetType = (workout: Workout): TargetType => {
  const first = workout.steps[0];
  if (!first)
    throw new WorkoutValidationError([
      { path: "steps", message: "a workout needs at least one step" },
    ]);
  const leaf = first.kind === "repeat" ? first.steps[0] : first;
  if (!leaf)
    throw new WorkoutValidationError([
      { path: "steps[0].steps", message: "a repeat needs at least one step" },
    ]);
  return leaf.target.type;
};
