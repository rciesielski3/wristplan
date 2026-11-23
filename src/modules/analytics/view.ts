import { formatDistance, formatDuration } from "../activities";
import { parseDay } from "../calendar/dates";
import { MAX_ANCHOR, MIN_ANCHOR } from "../calendar/grid";
import type { PlanStats, TrendSeries, VolumeStats } from "./aggregate";
import { formatDelta, formatOf, formatPercent } from "./format";
import type { DashboardData } from "./load";
import {
  DEFAULT_PERIOD_COUNT,
  PERIOD_COUNTS,
  type PeriodKind,
  parsePeriodCount,
  parsePeriodKind,
  shiftAnchor,
} from "./periods";

export const ESTIMATE_LABEL = "Estimate: calculated from stored activities, not a Garmin metric";

const SPORT_LABELS: Record<string, string> = {
  running: "Running",
  cycling: "Cycling",
  walking: "Walking",
  hiking: "Hiking",
  strength_training: "Strength training",
  mobility: "Mobility",
  other: "Other",
  unknown: "Unknown",
};

export const sportLabel = (key: string): string =>
  Object.hasOwn(SPORT_LABELS, key) ? (SPORT_LABELS[key] ?? key) : key;

type Param = string | readonly string[] | undefined;
const first = (value: Param): string | undefined =>
  typeof value === "string" ? value : value?.[0];

export interface DashboardQuery {
  readonly kind: PeriodKind;
  readonly count: number;
}

// Parsed once; the same kind and count feed the loader, the period math and every link.
export function parseDashboardQuery(period: Param, n: Param): DashboardQuery {
  const kind = parsePeriodKind(first(period));
  return { kind, count: parsePeriodCount(kind, first(n)) };
}

export const dashboardHref = (kind: PeriodKind, count: number, date?: string): string =>
  `/dashboard?period=${kind}&n=${count}${date === undefined ? "" : `&date=${date}`}`;

const inRange = (day: string): boolean => day >= MIN_ANCHOR && day <= MAX_ANCHOR;

function target(kind: PeriodKind, anchor: string, count: number, dir: "prev" | "next") {
  try {
    parseDay(anchor);
    const day = shiftAnchor(kind, anchor, count, dir);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && inRange(day) ? day : null;
  } catch {
    return null;
  }
}

export function navTargets(kind: PeriodKind, anchor: string, count: number) {
  return {
    prev: target(kind, anchor, count, "prev"),
    next: target(kind, anchor, count, "next"),
  };
}

export function volumeCell(s: VolumeStats): string {
  if (s.count === 0) return "0";
  const duration = formatDuration(s.durationSeconds);
  const distance = formatDistance(s.distanceMeters);
  const d = s.durationKnown < s.count ? `${duration} (${s.durationKnown} of ${s.count})` : duration;
  const k = s.distanceKnown < s.count ? `${distance} (${s.distanceKnown} of ${s.count})` : distance;
  return `${s.count} · ${d} · ${k}`;
}

export function planCells(p: PlanStats) {
  const t = p.time;
  return {
    completed: formatOf(p.matched, p.due),
    upcoming: String(p.upcoming),
    excludedNoMatch: String(p.excludedNoMatch),
    excludedUnavailable: String(p.excludedUnavailable),
    time:
      t.pairsWithBoth === 0
        ? "—"
        : `${formatDuration(t.actualSeconds)} actual vs ${formatDuration(t.plannedSeconds)} planned${t.ratio === null ? "" : ` (${formatPercent(t.ratio)})`} over ${t.pairsWithBoth} of ${t.matched} matched pairs`,
  };
}

function trendRows(series: readonly TrendSeries[], metric: "duration" | "distance") {
  return series.map((s) => ({
    label: s.sport === null ? "Overall" : sportLabel(s.sport),
    cells: s.points.map((pt) => formatDelta(pt[metric], metric)),
  }));
}

export function buildDashboardView(data: DashboardData, query: DashboardQuery, anchor: string) {
  const { kind, count } = query;
  const { periods } = data.periodSet;
  const unit = kind === "week" ? "week" : "month";
  const { prev, next } = navTargets(kind, anchor, count);
  const link = (d: string | null) => (d === null ? null : dashboardHref(kind, count, d));
  const sports = data.volume.sports;
  const rowOf = (label: string, row: readonly VolumeStats[], total: VolumeStats) => ({
    label,
    cells: row.map(volumeCell),
    total: volumeCell(total),
  });
  const trendSeries = data.trend === null ? null : [data.trend.overall, ...data.trend.sports];
  const hasUnknown = (s: VolumeStats) => s.durationKnown < s.count || s.distanceKnown < s.count;

  return {
    range: `${data.periodSet.from} to ${data.periodSet.to}`,
    nav: {
      prev: link(prev),
      next: link(next),
      latest: dashboardHref(kind, count),
      kinds: (["week", "month"] as const).map((k) => ({
        label: k === "week" ? "Week" : "Month",
        href: dashboardHref(k, DEFAULT_PERIOD_COUNT[k], anchor),
        current: k === kind,
      })),
      counts: PERIOD_COUNTS[kind].map((n) => ({
        label: `${n} ${unit}s`,
        href: dashboardHref(kind, n, anchor),
        current: n === count,
      })),
    },
    periodLabels: periods.map((p) => p.label),
    volume: {
      empty: sports.length === 0,
      rows:
        sports.length === 0
          ? []
          : [
              ...sports.map((s) => rowOf(sportLabel(s.sport), s.perPeriod, s.total)),
              rowOf("Total", data.volume.totals, data.volume.overall),
            ],
      hasUnknown: sports.some((s) => s.perPeriod.some(hasUnknown)),
    },
    plans:
      data.plans === null
        ? null
        : {
            rows: [
              ...data.plans.perPeriod.map((p, i) => ({
                label: periods[i]?.label ?? "",
                ...planCells(p),
              })),
              { label: "Overall", ...planCells(data.plans.overall) },
            ],
          },
    trend:
      trendSeries === null
        ? null
        : {
            columns: periods.slice(1).map((p) => p.label),
            duration: trendRows(trendSeries, "duration"),
            distance: trendRows(trendSeries, "distance"),
          },
    notices: data.notices,
    lastSync: data.lastSync ?? "never",
  };
}

export type DashboardView = ReturnType<typeof buildDashboardView>;
