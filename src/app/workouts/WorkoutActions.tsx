"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  readonly id: string;
  readonly name: string;
  readonly isTemplate: boolean;
  readonly corrupt?: boolean;
  readonly redirectTo?: string;
}

export function WorkoutActions({ id, name, isTemplate, corrupt = false, redirectTo }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function call(path: string, method: "POST" | "DELETE") {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/workouts/${id}${path}`, { method });
      if (res.ok) {
        if (redirectTo) router.push(redirectTo);
        else router.refresh();
      } else setMessage(`Request failed (${res.status})`);
    } catch {
      setMessage("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="actions">
      {corrupt ? null : isTemplate ? (
        <button type="button" disabled={busy} onClick={() => call("/use-template", "POST")}>
          Use template
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => call("/duplicate?asTemplate=true", "POST")}
        >
          Save as template
        </button>
      )}
      {corrupt ? null : (
        <button type="button" disabled={busy} onClick={() => call("/duplicate", "POST")}>
          Duplicate
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Delete "${name}"?`)) void call("", "DELETE");
        }}
      >
        Delete
      </button>
      {message ? <span role="status">{message}</span> : null}
    </div>
  );
}
