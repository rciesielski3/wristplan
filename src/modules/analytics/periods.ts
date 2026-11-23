import { addDays, MONTHS, monthStart, weekStart } from "../calendar/grid";

export type PeriodKind = "week" | "month";

export interface Period {
  readonly key: string;
  readonly start: string;
  readonly end: string;
  readonly label: string;
}

export interface PeriodSet {
  readonly kind: PeriodKind;
  readonly periods: readonly Period[];
  readonly from: string;
  readonly to: string;
}

export const PERIOD_COUNTS: Record<PeriodKind, readonly number[]> = {
  week: [4, 8, 12],
  month: [3, 6, 12],
};
export const DEFAULT_PERIOD_KIND: PeriodKind = "week";
export const DEFAULT_PERIOD_COUNT: Record<PeriodKind, number> = { week: 8, month: 6 };

export const parsePeriodKind = (value: string | readonly string[] | undefined): PeriodKind =>
  value === "week" || value === "month" ? value : DEFAULT_PERIOD_KIND;

const normalizeCount = (kind: PeriodKind, n: number): number =>
  PERIOD_COUNTS[kind].includes(n) ? n : DEFAULT_PERIOD_COUNT[kind];

// Only plain decimal strings count; "8.0", "08", " 8", arrays and junk fall back to the default.
export function parsePeriodCount(kind: PeriodKind, value: string | readonly string[] | undefined) {
  const n = typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
  return normalizeCount(kind, n);
}

// Precondition: anchor is a valid YYYY-MM-DD (use parseAnchor). Month anchors move by whole months.
export function shiftAnchor(
  kind: PeriodKind,
  anchor: string,
  n: number,
  direction: "prev" | "next",
): string {
  const count = normalizeCount(kind, n);
  const sign = direction === "prev" ? -1 : 1;
  return kind === "week" ? addDays(anchor, sign * 7 * count) : monthStart(anchor, sign * count);
}

function periodAt(kind: PeriodKind, anchor: string, offset: number): Period {
  if (kind === "week") {
    const start = addDays(weekStart(anchor), offset * 7);
    return { key: start, start, end: addDays(start, 6), label: `Mon ${start}` };
  }
  const start = monthStart(anchor, offset);
  return {
    key: start.slice(0, 7),
    start,
    end: addDays(monthStart(anchor, offset + 1), -1),
    label: `${MONTHS[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`,
  };
}

// Precondition: anchor is a valid YYYY-MM-DD. Returns the n buckets ending at the anchor's bucket, oldest first.
export function buildPeriods(kind: PeriodKind, anchor: string, n: number): PeriodSet {
  const count = normalizeCount(kind, n);
  const periods = Array.from({ length: count }, (_, i) => periodAt(kind, anchor, i - (count - 1)));
  const first = periods[0];
  const last = periods[count - 1];
  return { kind, periods, from: first?.start ?? anchor, to: last?.end ?? anchor };
}
