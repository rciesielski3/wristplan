import { addDays, buildGrid, type CalendarGrid, weekStart } from "./grid";
import type { CalendarData, ScheduledItem } from "./view";

export type Chip = "matched" | "due" | "upcoming" | "no-match";

export const CHIP_LABEL: Record<Chip, string> = {
  matched: "Matched",
  due: "Due",
  upcoming: "Upcoming",
  "no-match": "No match",
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const HORIZON_DAYS = 14;

// This week plus the next, so "next planned workout" can look past Sunday. loadCalendar only reads from/to.
export function homeGrid(today: string): CalendarGrid {
  const week = buildGrid("week", today);
  return { ...week, to: addDays(week.from, HORIZON_DAYS - 1) };
}

// Same "due" rule as the dashboard: planned for today or earlier and not matched.
export function itemChip(item: Pick<ScheduledItem, "state" | "date">, today: string): Chip {
  if (item.state === "matched") return "matched";
  if (item.state === "no-match") return "no-match";
  return item.state === "missed" || item.date <= today ? "due" : "upcoming";
}

export interface TodayItem {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly chip: Chip;
}

export interface TodayCard {
  readonly heading: string;
  readonly date: string | null;
  readonly items: readonly TodayItem[];
}

export function buildTodayCard(data: CalendarData, today: string): TodayCard {
  const date = Object.keys(data.days)
    .filter((d) => d >= today && (data.days[d]?.scheduled.length ?? 0) > 0)
    .sort()[0];
  if (date === undefined) return { heading: "Today", date: null, items: [] };
  const scheduled = data.days[date]?.scheduled ?? [];
  return {
    heading: date === today ? "Today" : `Next planned, ${date}`,
    date,
    items: scheduled.map((i) => ({
      id: i.id,
      name: i.name,
      summary: i.summary,
      chip: itemChip(i, today),
    })),
  };
}

export interface StripDay {
  readonly date: string;
  readonly weekday: string;
  readonly isToday: boolean;
  readonly planned: number;
  readonly completed: number;
  readonly chip: Chip | null;
}

const PRIORITY: readonly Chip[] = ["due", "upcoming", "matched", "no-match"];

export function buildWeekStrip(data: CalendarData, today: string): StripDay[] {
  const first = weekStart(today);
  return WEEKDAYS.map((weekday, i) => {
    const date = addDays(first, i);
    const day = data.days[date];
    const scheduled = day?.scheduled ?? [];
    const chips = new Set(scheduled.map((s) => itemChip(s, today)));
    return {
      date,
      weekday,
      isToday: date === today,
      planned: scheduled.length,
      completed:
        scheduled.filter((s) => s.state === "matched").length + (day?.activities.length ?? 0),
      chip: PRIORITY.find((c) => chips.has(c)) ?? null,
    };
  });
}
