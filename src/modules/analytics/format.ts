import { formatDistance, formatDuration } from "../activities";
import type { Delta } from "./aggregate";

const EMPTY = "—";

export function formatPercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return EMPTY;
  return `${Math.round(ratio * 100)}%`;
}

export function formatOf(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return EMPTY;
  return `${part} of ${whole} (${formatPercent(part / whole)})`;
}

export function formatDelta(delta: Delta | null, unit: "duration" | "distance"): string {
  if (delta === null || !Number.isFinite(delta.absolute) || !Number.isFinite(delta.percent)) {
    return EMPTY;
  }
  // Sign follows the displayed precision (1 s, 0.01 km) so a tiny change never shows "-0:00".
  const step = unit === "duration" ? 1 : 10;
  const abs = Math.abs(delta.absolute);
  const amount = unit === "duration" ? formatDuration(abs) : formatDistance(abs);
  const pct = Math.round(Math.abs(delta.percent));
  const negative = (n: number) => (n < 0 ? "-" : "+");
  const amountSign = Math.round(abs / step) === 0 ? "" : negative(delta.absolute);
  const pctSign = pct === 0 ? "" : negative(delta.percent);
  return `${amountSign}${amount} (${pctSign}${pct}%)`;
}
