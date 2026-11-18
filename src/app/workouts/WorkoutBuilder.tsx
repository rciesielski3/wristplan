"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { cloneElement, type ReactElement, useId, useRef, useState } from "react";
import {
  changeTarget,
  type EndType,
  type FormInner,
  type FormLeaf,
  type FormRepeat,
  type FormStep,
  formToWorkout,
  lastValues,
  moveItem,
  newInner,
  newLeaf,
  newRepeat,
  type PowerUnit,
  type StepValues,
  type WorkoutForm,
} from "../../modules/workouts/form";
import type { TargetType } from "../../modules/workouts/model";
import { toIntervalsText } from "../../modules/workouts/text";
import { validateWorkout, type WorkoutIssue } from "../../modules/workouts/validate";

const KEY_STRIDE = 3;
const LEAF_KINDS = ["warmup", "work", "recovery", "cooldown"] as const;
const INNER_KINDS = ["work", "recovery"] as const;

function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}

function EndFields<T extends FormLeaf | FormInner>({
  step,
  onChange,
  label,
}: {
  step: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <>
      <Field label={`${label} end type`}>
        <select
          value={step.endType}
          onChange={(e) => onChange({ ...step, endType: e.target.value as EndType })}
        >
          <option value="time">Time</option>
          <option value="distance">Distance</option>
        </select>
      </Field>
      <Field label={`${label} ${step.endType === "time" ? "duration (min:sec)" : "distance (km)"}`}>
        <input
          value={step.amount}
          onChange={(e) => onChange({ ...step, amount: e.target.value })}
        />
      </Field>
    </>
  );
}

function Mover({
  label,
  index,
  count,
  onMove,
  onRemove,
}: {
  label: string;
  index: number;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  return (
    <span className="mover">
      <button type="button" disabled={index === 0} onClick={() => onMove(index - 1)}>
        Move {label} up
      </button>
      <button type="button" disabled={index === count - 1} onClick={() => onMove(index + 1)}>
        Move {label} down
      </button>
      <button type="button" onClick={onRemove}>
        Remove {label}
      </button>
    </span>
  );
}

function TargetTypeFields({
  form,
  onChange,
}: {
  form: WorkoutForm;
  onChange: (f: WorkoutForm) => void;
}) {
  return (
    <fieldset>
      <legend>Target type (one for the whole workout; values are set per step)</legend>
      <Field label="Target type">
        <select
          value={form.targetType}
          onChange={(e) =>
            onChange(changeTarget(form, e.target.value as TargetType, form.powerUnit))
          }
        >
          <option value="hr">Heart rate zone</option>
          <option value="pace">Pace range</option>
          <option value="power">Power</option>
        </select>
      </Field>
      {form.targetType === "power" ? (
        <Field label="Power unit">
          <select
            value={form.powerUnit}
            onChange={(e) => onChange(changeTarget(form, "power", e.target.value as PowerUnit))}
          >
            <option value="percent_ftp">% FTP</option>
            <option value="watts">Watts</option>
          </select>
        </Field>
      ) : null}
    </fieldset>
  );
}

function ValueFields<T extends { values: StepValues }>({
  type,
  step,
  label,
  onChange,
}: {
  type: TargetType;
  step: T;
  label: string;
  onChange: (next: T) => void;
}) {
  const set = (patch: Partial<StepValues>) =>
    onChange({ ...step, values: { ...step.values, ...patch } });
  const v = step.values;
  if (type === "hr")
    return (
      <Field label={`${label} heart rate zone (1-5)`}>
        <input value={v.zone} onChange={(e) => set({ zone: e.target.value })} />
      </Field>
    );
  if (type === "pace")
    return (
      <>
        <Field label={`${label} fastest pace (min:sec per km)`}>
          <input value={v.fast} onChange={(e) => set({ fast: e.target.value })} />
        </Field>
        <Field label={`${label} slowest pace (min:sec per km)`}>
          <input value={v.slow} onChange={(e) => set({ slow: e.target.value })} />
        </Field>
      </>
    );
  return (
    <>
      <Field label={`${label} power minimum`}>
        <input value={v.min} onChange={(e) => set({ min: e.target.value })} />
      </Field>
      <Field label={`${label} power maximum`}>
        <input value={v.max} onChange={(e) => set({ max: e.target.value })} />
      </Field>
    </>
  );
}

function RepeatEditor({
  step,
  type,
  label,
  nextKey,
  fallback,
  onChange,
}: {
  step: FormRepeat;
  type: TargetType;
  label: string;
  nextKey: () => number;
  fallback: StepValues;
  onChange: (s: FormRepeat) => void;
}) {
  const setInner = (i: number, next: FormInner) =>
    onChange({ ...step, steps: step.steps.map((s, j) => (j === i ? next : s)) });
  return (
    <>
      <Field label={`${label} repeat count`}>
        <input value={step.times} onChange={(e) => onChange({ ...step, times: e.target.value })} />
      </Field>
      {step.steps.map((inner, i) => {
        const innerLabel = `${label}.${i + 1}`;
        return (
          <div key={inner.key} className="inner">
            <Field label={`Step ${innerLabel} kind`}>
              <select
                value={inner.kind}
                onChange={(e) =>
                  setInner(i, { ...inner, kind: e.target.value as FormInner["kind"] })
                }
              >
                {INNER_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Field>
            <EndFields step={inner} label={`Step ${innerLabel}`} onChange={(n) => setInner(i, n)} />
            <ValueFields
              type={type}
              step={inner}
              label={`Step ${innerLabel}`}
              onChange={(n) => setInner(i, n)}
            />
            <Mover
              label={`step ${innerLabel}`}
              index={i}
              count={step.steps.length}
              onMove={(to) => onChange({ ...step, steps: moveItem(step.steps, i, to) })}
              onRemove={() => onChange({ ...step, steps: step.steps.filter((_, j) => j !== i) })}
            />
          </div>
        );
      })}
      <button
        type="button"
        onClick={() =>
          onChange({
            ...step,
            steps: [
              ...step.steps,
              newInner(nextKey(), "work", step.steps.at(-1)?.values ?? fallback),
            ],
          })
        }
      >
        Add step to repeat {label}
      </button>
    </>
  );
}

export function WorkoutBuilder({ initial, id }: { initial: WorkoutForm; id?: string }) {
  const router = useRouter();
  const [form, setForm] = useState<WorkoutForm>(initial);
  const [serverIssues, setServerIssues] = useState<readonly WorkoutIssue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const counter = useRef(1000);
  const nextKey = () => {
    counter.current += KEY_STRIDE;
    return counter.current;
  };

  const candidate = formToWorkout(form);
  const result = validateWorkout(candidate);
  const issues = result.ok ? serverIssues : result.issues;
  const setStep = (i: number, next: FormStep) =>
    setForm({ ...form, steps: form.steps.map((s, j) => (j === i ? next : s)) });

  async function save() {
    if (!result.ok || submitting.current) return;
    submitting.current = true;
    let navigating = false;
    setBusy(true);
    setMessage(null);
    setServerIssues([]);
    try {
      const res = await fetch(id ? `/api/workouts/${id}` : "/api/workouts", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.workout),
      });
      if (res.ok) {
        navigating = true;
        router.push("/workouts");
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { issues?: WorkoutIssue[] };
      if (res.status === 422 && body.issues) setServerIssues(body.issues);
      setMessage(`Save failed (${res.status})`);
    } catch {
      setMessage("Save failed");
    } finally {
      if (!navigating) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Name">
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <TargetTypeFields form={form} onChange={setForm} />

      <h2>Steps</h2>
      <ol className="steps">
        {form.steps.map((step, i) => {
          const label = String(i + 1);
          return (
            <li key={step.key}>
              {step.kind === "repeat" ? (
                <RepeatEditor
                  step={step}
                  label={label}
                  type={form.targetType}
                  nextKey={nextKey}
                  fallback={lastValues(form)}
                  onChange={(s) => setStep(i, s)}
                />
              ) : (
                <>
                  <Field label={`Step ${label} kind`}>
                    <select
                      value={step.kind}
                      onChange={(e) =>
                        setStep(i, { ...step, kind: e.target.value as FormLeaf["kind"] })
                      }
                    >
                      {LEAF_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <EndFields step={step} label={`Step ${label}`} onChange={(n) => setStep(i, n)} />
                  <ValueFields
                    type={form.targetType}
                    step={step}
                    label={`Step ${label}`}
                    onChange={(n) => setStep(i, n)}
                  />
                </>
              )}
              <Mover
                label={`step ${label}`}
                index={i}
                count={form.steps.length}
                onMove={(to) => setForm({ ...form, steps: moveItem(form.steps, i, to) })}
                onRemove={() => setForm({ ...form, steps: form.steps.filter((_, j) => j !== i) })}
              />
            </li>
          );
        })}
      </ol>
      <p>
        <button
          type="button"
          onClick={() =>
            setForm({
              ...form,
              steps: [...form.steps, newLeaf(nextKey(), "work", lastValues(form))],
            })
          }
        >
          Add step
        </button>{" "}
        <button
          type="button"
          onClick={() =>
            setForm({ ...form, steps: [...form.steps, newRepeat(nextKey(), lastValues(form))] })
          }
        >
          Add repeat
        </button>
      </p>

      {issues.length > 0 ? (
        <ul aria-label="Validation issues" className="issues">
          {issues.map((i) => (
            <li key={`${i.path}:${i.message}`}>
              {i.path}: {i.message}
            </li>
          ))}
        </ul>
      ) : null}

      <h2>intervals.icu text preview</h2>
      <pre>{result.ok ? toIntervalsText(result.workout) : "—"}</pre>

      <p>
        <button type="submit" disabled={busy || !result.ok}>
          {id ? "Save changes" : "Create workout"}
        </button>{" "}
        <Link href="/workouts">Cancel</Link>
      </p>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
