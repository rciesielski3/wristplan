import { ScheduleValidationError } from "./errors";

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_PAST_DAYS = 366;
export const MAX_FUTURE_DAYS = 731;
export const MAX_LIST_RANGE_DAYS = 366;

const toIso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function parseDay(value: string): number {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) throw new ScheduleValidationError("date must be YYYY-MM-DD");
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d);
  if (toIso(ms) !== value) throw new ScheduleValidationError("date is not a real calendar day");
  return ms;
}

export function assertScheduleDate(value: string, now: Date): void {
  const day = parseDay(value);
  const today = parseDay(toIso(now.getTime()));
  if (day < today - MAX_PAST_DAYS * DAY_MS || day > today + MAX_FUTURE_DAYS * DAY_MS) {
    throw new ScheduleValidationError("date is outside the allowed scheduling window");
  }
}

export function assertListRange(from: string, to: string): void {
  const span = parseDay(to) - parseDay(from);
  if (span < 0) throw new ScheduleValidationError("from must not be after to");
  if (span > MAX_LIST_RANGE_DAYS * DAY_MS) {
    throw new ScheduleValidationError(`range must be at most ${MAX_LIST_RANGE_DAYS} days`);
  }
}
