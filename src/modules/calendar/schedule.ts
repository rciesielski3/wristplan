import { randomUUID } from "node:crypto";
import type { Db } from "../../lib/db";
import { OWNED_EXTERNAL_ID_PREFIX } from "../intervals";
import {
  createWorkoutRepository,
  toIntervalsText,
  type WorkoutRepository,
  workoutTargetType,
} from "../workouts";
import { assertListRange, assertScheduleDate } from "./dates";
import {
  ScheduleConflictError,
  ScheduleForeignEventError,
  ScheduleListOverflowError,
  ScheduleNotFoundError,
  SchedulePublishError,
} from "./errors";
import {
  PublisherError,
  PublisherForeignEventError,
  PublisherNotFoundError,
  PublisherRateLimitError,
  PublisherTransientError,
  type WorkoutPublisher,
} from "./publisher";

export const MAX_TRANSIENT_RETRIES = 2;
export const SCHEDULE_LIST_LIMIT = 500;
const BACKOFF_BASE_MS = 1000;
const UNIQUE_VIOLATION = "P2002";

export type ScheduleStatus = "pending" | "published" | "failed";

export interface Schedule {
  readonly id: string;
  readonly workoutId: string;
  readonly date: string;
  readonly status: ScheduleStatus;
  readonly externalId: string;
  readonly remoteEventId: string | null;
  readonly lastError: string | null;
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ScheduleServiceOptions {
  readonly db: Db;
  readonly publisher: WorkoutPublisher;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

// Error class and status only: raw messages may carry request detail and must not reach the db.
const redact = (err: unknown): string => {
  if (err instanceof PublisherError) {
    return err.status === undefined ? err.name : `${err.name} (${err.status})`;
  }
  return err instanceof Error ? err.name : "UnknownError";
};

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && "code" in err && err.code === UNIQUE_VIOLATION;

const isRetryable = (err: unknown): boolean =>
  err instanceof PublisherRateLimitError || err instanceof PublisherTransientError;

interface Row extends Omit<Schedule, "status"> {
  status: string;
}

const toSchedule = (row: Row): Schedule => ({ ...row, status: row.status as ScheduleStatus });

export function createScheduleService(options: ScheduleServiceOptions) {
  const { db, publisher } = options;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const workouts: WorkoutRepository = createWorkoutRepository(db);

  async function withRetry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call();
      } catch (err) {
        if (!isRetryable(err) || attempt >= MAX_TRANSIENT_RETRIES) throw err;
        await sleep(BACKOFF_BASE_MS * 2 ** attempt);
      }
    }
  }

  const load = async (id: string): Promise<Row> => {
    const row =
      typeof id === "string" ? await db.scheduledWorkout.findUnique({ where: { id } }) : null;
    if (!row) throw new ScheduleNotFoundError();
    return row;
  };

  const record = async (id: string, err: unknown): Promise<Row> =>
    db.scheduledWorkout.update({ where: { id }, data: { lastError: redact(err) } });

  // Re-reads the workout so a retry publishes its current definition.
  async function attempt(row: Row): Promise<Schedule> {
    try {
      const { workout } = await workouts.get(row.workoutId);
      const { remoteId } = await withRetry(() =>
        publisher.publish({
          externalId: row.externalId,
          date: row.date,
          name: workout.name,
          text: toIntervalsText(workout),
          sport: workout.sport,
          target: workoutTargetType(workout),
        }),
      );
      return toSchedule(
        await db.scheduledWorkout.update({
          where: { id: row.id },
          data: {
            status: "published",
            remoteEventId: remoteId,
            lastError: null,
            publishedAt: now(),
          },
        }),
      );
    } catch (err) {
      return toSchedule(
        await db.scheduledWorkout.update({
          where: { id: row.id },
          data: { status: "failed", lastError: redact(err) },
        }),
      );
    }
  }

  async function remote(row: Row, call: () => Promise<void>, missingOk = false): Promise<void> {
    try {
      await withRetry(call);
    } catch (err) {
      if (missingOk && err instanceof PublisherNotFoundError) return;
      await record(row.id, err);
      if (err instanceof PublisherForeignEventError) throw new ScheduleForeignEventError();
      throw new SchedulePublishError(redact(err));
    }
  }

  return {
    async schedule(workoutId: string, date: string): Promise<Schedule> {
      assertScheduleDate(date, now());
      const { workout } = await workouts.get(workoutId);
      // Fail before a row is created: an unserialisable workout must leave nothing behind.
      toIntervalsText(workout);
      const existing = await db.scheduledWorkout.findUnique({
        where: { workoutId_date: { workoutId, date } },
      });
      if (existing)
        return existing.status === "published" ? toSchedule(existing) : attempt(existing);
      const id = randomUUID();
      let row: Row;
      try {
        row = await db.scheduledWorkout.create({
          data: {
            id,
            workoutId,
            date,
            status: "pending",
            externalId: `${OWNED_EXTERNAL_ID_PREFIX}${id}`,
          },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const raced = await db.scheduledWorkout.findUnique({
          where: { workoutId_date: { workoutId, date } },
        });
        if (!raced) throw err;
        return toSchedule(raced);
      }
      return attempt(row);
    },

    async retry(id: string): Promise<Schedule> {
      const row = await load(id);
      assertScheduleDate(row.date, now());
      return row.status === "published" ? toSchedule(row) : attempt(row);
    },

    async reschedule(id: string, newDate: string): Promise<Schedule> {
      assertScheduleDate(newDate, now());
      const row = await load(id);
      if (row.date === newDate) return toSchedule(row);
      const taken = await db.scheduledWorkout.findUnique({
        where: { workoutId_date: { workoutId: row.workoutId, date: newDate } },
        select: { id: true },
      });
      if (taken) throw new ScheduleConflictError();
      if (row.status === "published" && row.remoteEventId !== null) {
        const remoteId = row.remoteEventId;
        await remote(row, () => publisher.reschedule(remoteId, newDate));
      }
      return toSchedule(
        await db.scheduledWorkout.update({
          where: { id },
          data: { date: newDate, ...(row.status === "published" ? { lastError: null } : {}) },
        }),
      );
    },

    async unschedule(id: string): Promise<void> {
      let row: Row = await load(id);
      // A row without a remote id may still have a remote event (crash or lost response). Publish is
      // idempotent per externalId, so it resolves the id; only then is removal safe.
      if (row.status !== "published" || row.remoteEventId === null) {
        row = await attempt(row);
        if (row.status !== "published" || row.remoteEventId === null) {
          throw new SchedulePublishError("remote state unknown");
        }
      }
      const remoteId = row.remoteEventId;
      // Already gone remotely (or removed by a retried call): the goal state is reached.
      await remote(row, () => publisher.remove(remoteId), true);
      await db.scheduledWorkout.deleteMany({ where: { id } });
    },

    async list(range: { from: string; to: string }): Promise<Schedule[]> {
      assertListRange(range.from, range.to);
      const rows = await db.scheduledWorkout.findMany({
        where: { date: { gte: range.from, lte: range.to } },
        orderBy: [{ date: "asc" }, { id: "asc" }],
        take: SCHEDULE_LIST_LIMIT + 1,
      });
      if (rows.length > SCHEDULE_LIST_LIMIT) throw new ScheduleListOverflowError();
      return rows.map(toSchedule);
    },
  };
}

export type ScheduleService = ReturnType<typeof createScheduleService>;
