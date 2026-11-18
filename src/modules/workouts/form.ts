import type { RepeatStep, Step, Target, TargetType, Workout } from "./model";
import { workoutTargetType } from "./validate";

export type EndType = "time" | "distance";
export type PowerUnit = "watts" | "percent_ftp";
export type StepKind = Step["kind"] | "repeat";

export interface StepValues {
  readonly zone: string;
  readonly fast: string;
  readonly slow: string;
  readonly min: string;
  readonly max: string;
}

export interface FormLeaf {
  readonly key: number;
  readonly kind: Step["kind"];
  readonly endType: EndType;
  readonly amount: string;
  readonly values: StepValues;
}

export interface FormInner {
  readonly key: number;
  readonly kind: RepeatStep["kind"];
  readonly endType: EndType;
  readonly amount: string;
  readonly values: StepValues;
}

export interface FormRepeat {
  readonly key: number;
  readonly kind: "repeat";
  readonly times: string;
  readonly steps: readonly FormInner[];
}

export type FormStep = FormLeaf | FormRepeat;

export interface WorkoutForm {
  readonly name: string;
  readonly targetType: TargetType;
  readonly powerUnit: PowerUnit;
  readonly steps: readonly FormStep[];
}

const SEC_PER_MIN = 60;
const pad2 = (n: number): string => String(n).padStart(2, "0");

// Unparseable text becomes NaN so validateWorkout reports it at the right path.
export function parseClock(text: string): number {
  const m = /^(\d{1,4}):([0-5]?\d)$/.exec(text.trim());
  if (m) return Number(m[1]) * SEC_PER_MIN + Number(m[2]);
  return /^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) * SEC_PER_MIN : Number.NaN;
}

export const formatClock = (seconds: number): string =>
  `${Math.floor(seconds / SEC_PER_MIN)}:${pad2(seconds % SEC_PER_MIN)}`;

const parseInteger = (text: string): number =>
  /^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;

export function parseKm(text: string): number {
  const t = text.trim().replace(",", ".");
  return /^\d{1,3}(\.\d{1,3})?$/.test(t) ? Math.round(Number(t) * 1000) : Number.NaN;
}

const formatKm = (meters: number): string => String(meters / 1000);

const toEnd = (endType: EndType, amount: string) =>
  endType === "time"
    ? { type: "time", seconds: parseClock(amount) }
    : { type: "distance", meters: parseKm(amount) };

const toTarget = (type: TargetType, unit: PowerUnit, v: StepValues): unknown => {
  switch (type) {
    case "hr":
      return { type, zone: parseInteger(v.zone) };
    case "pace":
      return { type, fastSecPerKm: parseClock(v.fast), slowSecPerKm: parseClock(v.slow) };
    case "power":
      return { type, unit, min: parseInteger(v.min), max: parseInteger(v.max) };
  }
};

export function formToWorkout(form: WorkoutForm): unknown {
  const leaf = (s: FormLeaf | FormInner) => ({
    kind: s.kind,
    end: toEnd(s.endType, s.amount),
    target: toTarget(form.targetType, form.powerUnit, s.values),
  });
  return {
    name: form.name,
    sport: "run",
    steps: form.steps.map((s) =>
      s.kind === "repeat"
        ? { kind: "repeat", times: parseInteger(s.times), steps: s.steps.map((i) => leaf(i)) }
        : leaf(s),
    ),
  };
}

export const defaultValues = (): StepValues => ({
  zone: "2",
  fast: "5:00",
  slow: "5:30",
  min: "70",
  max: "80",
});

export const blankValues = (): StepValues => ({ zone: "", fast: "", slow: "", min: "", max: "" });

const fromTarget = (target: Target): StepValues => {
  const base = blankValues();
  switch (target.type) {
    case "hr":
      return { ...base, zone: String(target.zone) };
    case "pace":
      return {
        ...base,
        fast: formatClock(target.fastSecPerKm),
        slow: formatClock(target.slowSecPerKm),
      };
    case "power":
      return { ...base, min: String(target.min), max: String(target.max) };
  }
};

const fromEnd = (end: Step["end"]): { endType: EndType; amount: string } =>
  end.type === "time"
    ? { endType: "time", amount: formatClock(end.seconds) }
    : { endType: "distance", amount: formatKm(end.meters) };

const firstPowerUnit = (workout: Workout): PowerUnit => {
  for (const s of workout.steps)
    for (const leaf of s.kind === "repeat" ? s.steps : [s])
      if (leaf.target.type === "power") return leaf.target.unit;
  return "percent_ftp";
};

export function workoutToForm(workout: Workout): WorkoutForm {
  let key = 0;
  const next = () => ++key;
  const common = (s: { end: Step["end"]; target: Target }) => ({
    key: next(),
    ...fromEnd(s.end),
    values: fromTarget(s.target),
  });
  const leaf = (s: Step): FormLeaf => ({ ...common(s), kind: s.kind });
  const inner = (s: RepeatStep): FormInner => ({ ...common(s), kind: s.kind });
  return {
    name: workout.name,
    targetType: workoutTargetType(workout),
    powerUnit: firstPowerUnit(workout),
    steps: workout.steps.map(
      (s): FormStep =>
        s.kind === "repeat"
          ? {
              key: next(),
              kind: "repeat",
              times: String(s.times),
              steps: s.steps.map(inner),
            }
          : leaf(s),
    ),
  };
}

// Values of one target type cannot be converted to another, so they are cleared and must be re-entered.
export function changeTarget(
  form: WorkoutForm,
  targetType: TargetType,
  powerUnit: PowerUnit,
): WorkoutForm {
  if (targetType === form.targetType && (targetType !== "power" || powerUnit === form.powerUnit))
    return form;
  const blank = <T extends { values: StepValues }>(s: T): T => ({ ...s, values: blankValues() });
  return {
    ...form,
    targetType,
    powerUnit,
    steps: form.steps.map((s) =>
      s.kind === "repeat" ? { ...s, steps: s.steps.map((i) => blank(i)) } : blank(s),
    ),
  };
}

export const lastValues = (form: WorkoutForm): StepValues => {
  const last = form.steps.at(-1);
  const leaf = last?.kind === "repeat" ? last.steps.at(-1) : last;
  return leaf?.values ?? defaultValues();
};

export const newLeaf = (
  key: number,
  kind: Step["kind"] = "work",
  values: StepValues = defaultValues(),
): FormLeaf => ({ key, kind, endType: "time", amount: "10:00", values });

export const newInner = (
  key: number,
  kind: RepeatStep["kind"] = "work",
  values: StepValues = defaultValues(),
): FormInner => ({ key, kind, endType: "time", amount: "3:00", values });

export const newRepeat = (key: number, values: StepValues = defaultValues()): FormRepeat => ({
  key,
  kind: "repeat",
  times: "4",
  steps: [newInner(key + 1, "work", values), newInner(key + 2, "recovery", values)],
});

export const emptyForm = (): WorkoutForm => ({
  name: "",
  targetType: "hr",
  powerUnit: "percent_ftp",
  steps: [newLeaf(1, "warmup")],
});

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const copy = [...items];
  const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < items.length;
  if (!inRange(from) || !inRange(to)) return copy;
  copy.splice(to, 0, ...copy.splice(from, 1));
  return copy;
}

const sameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length &&
    ka.every((k) => k in b && sameJson(Reflect.get(a, k), Reflect.get(b, k)))
  );
};

// Returns null unless the form can reproduce the workout exactly, so saving never rewrites data.
export function editableForm(workout: Workout): WorkoutForm | null {
  const form = workoutToForm(workout);
  return sameJson(formToWorkout(form), workout) ? form : null;
}
