const EMPTY = "—";

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return EMPTY;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatDistance(meters: number | null): string {
  return meters === null ? EMPTY : `${(meters / 1000).toFixed(2)} km`;
}

export function formatText(value: string | null): string {
  return value === null || value === "" ? EMPTY : value;
}

export function formatTimestamp(date: Date | null): string {
  return date === null ? EMPTY : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
