"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { linkErrorMessage, scheduleErrorMessage } from "../../modules/calendar/messages";

// Covers a normal request and its server-side retries, not a full outage (up to ~3 min): the server
// keeps going and publishing is idempotent, so after "Request failed" the action is safe to repeat.
const REQUEST_TIMEOUT_MS = 60_000;
const PUBLISH_NOTICE = "Publishes to your real intervals.icu account.";

function useCall(errorMessage = scheduleErrorMessage) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function call(path: string, method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown) {
    setBusy(true);
    setMessage(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(path, {
        method,
        signal: controller.signal,
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
      setMessage(errorMessage(res.status, apiError));
    } catch {
      setMessage("Request failed");
    } finally {
      clearTimeout(timer);
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

interface LinkProps {
  readonly id: string;
  readonly name: string;
  readonly matchSource: "manual" | "none" | null;
  readonly candidates: readonly { id: string; label: string }[];
}

export function LinkControls({ id, name, matchSource, candidates }: LinkProps) {
  const { busy, message, call } = useCall(linkErrorMessage);
  const [activityId, setActivityId] = useState("");
  const base = `/api/schedule/${id}/link`;

  return (
    <div className="actions">
      <select
        value={activityId}
        aria-label={`Activity to link to ${name}`}
        onChange={(e) => setActivityId(e.target.value)}
      >
        <option value="">Choose an activity</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy || !candidates.some((c) => c.id === activityId)}
        aria-label={`Link ${name}`}
        onClick={() => call(base, "PUT", { garminActivityId: activityId })}
      >
        Link
      </button>
      {matchSource === "none" ? null : (
        <button
          type="button"
          disabled={busy}
          aria-label={`No match for ${name}`}
          onClick={() => call(base, "PUT", { none: true })}
        >
          No match
        </button>
      )}
      {matchSource === null ? null : (
        <button
          type="button"
          disabled={busy}
          aria-label={`Unlink ${name}`}
          onClick={() => call(base, "DELETE")}
        >
          Unlink
        </button>
      )}
      <small>
        {candidates.length === 0
          ? "No nearby unplanned activities."
          : "Showing unplanned activities within 7 days."}
      </small>
      <small>Only changes wristplan&apos;s local data; nothing is sent to intervals.icu.</small>
      {message ? <p role="alert">{message}</p> : null}
    </div>
  );
}
