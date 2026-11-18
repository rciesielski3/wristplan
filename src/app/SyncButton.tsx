"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface SyncSummary {
  readonly status?: string;
  readonly imported?: number;
  readonly updated?: number;
  readonly failed?: number;
  readonly errorMessage?: string | null;
  readonly error?: string;
}

export function SyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const body = (await res.json()) as SyncSummary;
      if (!res.ok) {
        setMessage(body.error ?? `Sync failed (${res.status})`);
      } else {
        const detail = body.errorMessage ? `, error: ${body.errorMessage}` : "";
        setMessage(
          `Sync ${body.status}: ${body.imported} imported, ${body.updated} updated, ${body.failed} failed${detail}`,
        );
      }
      router.refresh();
    } catch {
      setMessage("Sync request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sync">
      <button type="button" onClick={run} disabled={busy}>
        {busy ? "Syncing…" : "Sync now"}
      </button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
