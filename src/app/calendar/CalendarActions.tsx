"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { scheduleErrorMessage } from "../../modules/calendar/messages";

const PUBLISH_NOTICE = "Publishes to your real intervals.icu account.";

function useCall() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function call(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      const payload = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const apiError = typeof payload?.error === "string" ? payload.error : undefined;
      setMessage(scheduleErrorMessage(res.status, apiError));
    } catch {
      setMessage("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return { busy, message, call };
}

interface FormProps {
  readonly workouts: readonly { id: string; label: string }[];
  readonly defaultDate: string;
}

export function ScheduleForm({ workouts, defaultDate }: FormProps) {
  const { busy, message, call } = useCall();
  const [workoutId, setWorkoutId] = useState(workouts[0]?.id ?? "");
  const [date, setDate] = useState(defaultDate);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void call("/api/schedule", "POST", { workoutId, date });
      }}
    >
      <p>
        <strong>{PUBLISH_NOTICE}</strong>
      </p>
      <label className="field">
        Workout
        <select value={workoutId} onChange={(e) => setWorkoutId(e.target.value)} required>
          {workouts.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </label>
      <button type="submit" disabled={busy || workoutId === ""}>
        Schedule
      </button>
      {workouts.length === 0 ? <p>Create a workout first.</p> : null}
      {message ? <p role="alert">{message}</p> : null}
    </form>
  );
}

interface ItemProps {
  readonly id: string;
  readonly name: string;
  readonly date: string;
  readonly status: "pending" | "published" | "failed";
}

export function ItemActions({ id, name, date, status }: ItemProps) {
  const { busy, message, call } = useCall();
  const [newDate, setNewDate] = useState(date);
  const base = `/api/schedule/${id}`;

  return (
    <div className="actions">
      {status === "published" ? null : (
        <button
          type="button"
          disabled={busy}
          aria-label={`Retry ${name}`}
          title="Publishes to your real intervals.icu account."
          onClick={() => call(`${base}/retry`, "POST")}
        >
          Retry
        </button>
      )}
      <input
        type="date"
        value={newDate}
        aria-label={`New date for ${name}`}
        onChange={(e) => setNewDate(e.target.value)}
      />
      <button
        type="button"
        disabled={busy || newDate === "" || newDate === date}
        aria-label={`Reschedule ${name}`}
        title="Moves the event in your real intervals.icu account."
        onClick={() => call(base, "PATCH", { date: newDate })}
      >
        Reschedule
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label={`Remove ${name}`}
        title="Removes the event from your real intervals.icu account."
        onClick={() => call(base, "DELETE")}
      >
        Remove
      </button>
      <small>Acts on your real intervals.icu account.</small>
      {message ? <p role="alert">{message}</p> : null}
    </div>
  );
}
