import { parseDay, toIso } from "./dates";

export type CalendarView = "week" | "month";

export const DEFAULT_VIEW: CalendarView = "week";
// Keeps day arithmetic far from the Date range limit, where toISOString stops being YYYY-MM-DD.
const MIN_ANCHOR = "1970-01-01";
const MAX_ANCHOR = "2100-12-31";
const DAY_MS = 24 * 60 * 60 * 1000;
export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface CalendarGrid {
  readonly view: CalendarView;
  readonly anchor: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly weeks: readonly (readonly string[])[];
  // Month grids show days of neighbouring months; "YYYY-MM" of the anchor, null for week views.
  readonly month: string | null;
  readonly prev: string;
  readonly next: string;
}

// The server's local calendar day, so "today" matches the user's wall clock.
export const localDay = (now: Date): string =>
  `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export const parseView = (value: string | undefined): CalendarView =>
  value === "week" || value === "month" ? value : DEFAULT_VIEW;

export function parseAnchor(value: string | undefined, today: string): string {
  if (value === undefined) return today;
  try {
    parseDay(value);
  } catch {
    return today;
  }
  return value < MIN_ANCHOR || value > MAX_ANCHOR ? today : value;
}

export const addDays = (day: string, days: number): string => toIso(parseDay(day) + days * DAY_MS);

export function weekStart(day: string): string {
  const weekday = new Date(parseDay(day)).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

export const monthStart = (day: string, offset: number): string => {
  const [year, month] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
  return toIso(Date.UTC(year, month - 1 + offset, 1));
};

const weekRows = (first: string, count: number): string[][] =>
  Array.from({ length: count }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => addDays(first, w * 7 + d)),
  );

export function buildGrid(view: CalendarView, anchor: string): CalendarGrid {
  if (view === "week") {
    const from = weekStart(anchor);
    const to = addDays(from, 6);
    return {
      view,
      anchor,
      label: `${from} to ${to}`,
      from,
      to,
      weeks: weekRows(from, 1),
      month: null,
      prev: addDays(anchor, -7),
      next: addDays(anchor, 7),
    };
  }
  const first = monthStart(anchor, 0);
  const next = monthStart(anchor, 1);
  const gridStart = weekStart(first);
  const lastDay = addDays(next, -1);
  const rows = (parseDay(weekStart(lastDay)) - parseDay(gridStart)) / (7 * DAY_MS) + 1;
  const weeks = weekRows(gridStart, rows);
  return {
    view,
    anchor,
    label: `${MONTHS[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}`,
    from: gridStart,
    to: addDays(gridStart, rows * 7 - 1),
    weeks,
    month: anchor.slice(0, 7),
    prev: monthStart(anchor, -1),
    next,
  };
}
