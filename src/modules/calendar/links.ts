import type { Db } from "../../lib/db";
import {
  ActivityNotFoundError,
  ScheduleConflictError,
  ScheduleNotFoundError,
  ScheduleValidationError,
} from "./errors";
import { isUniqueViolation, type Schedule, toSchedule } from "./schedule";

// Garmin ids are positive integers (garmin client schema); this only bounds the shape, and an id
// above MAX_SAFE_INTEGER simply matches no Activity row (404).
const GARMIN_ID = /^[1-9][0-9]{0,15}$/;

export function createLinkService(options: { readonly db: Db }) {
  const { db } = options;

  async function update(
    scheduleId: string,
    data: { linkedGarminActivityId: string | null; matchSource: "manual" | "none" | null },
  ): Promise<Schedule> {
    try {
      return toSchedule(await db.scheduledWorkout.update({ where: { id: scheduleId }, data }));
    } catch (err) {
      if (isUniqueViolation(err)) throw new ScheduleConflictError();
      throw err;
    }
  }

  const assertExists = async (scheduleId: string): Promise<void> => {
    const row =
      typeof scheduleId === "string"
        ? await db.scheduledWorkout.findUnique({
            where: { id: scheduleId },
            select: { id: true },
          })
        : null;
    if (!row) throw new ScheduleNotFoundError();
  };

  return {
    async linkActivity(scheduleId: string, garminActivityId: string): Promise<Schedule> {
      if (typeof garminActivityId !== "string" || !GARMIN_ID.test(garminActivityId)) {
        throw new ScheduleValidationError("garminActivityId must be a Garmin activity id");
      }
      await assertExists(scheduleId);
      const activity = await db.activity.findUnique({
        where: { garminActivityId },
        select: { id: true },
      });
      if (!activity) throw new ActivityNotFoundError();
      const holder = await db.scheduledWorkout.findUnique({
        where: { linkedGarminActivityId: garminActivityId },
        select: { id: true },
      });
      if (holder && holder.id !== scheduleId) throw new ScheduleConflictError();
      return update(scheduleId, {
        linkedGarminActivityId: garminActivityId,
        matchSource: "manual",
      });
    },

    async markNoMatch(scheduleId: string): Promise<Schedule> {
      await assertExists(scheduleId);
      return update(scheduleId, { linkedGarminActivityId: null, matchSource: "none" });
    },

    async unlink(scheduleId: string): Promise<Schedule> {
      await assertExists(scheduleId);
      return update(scheduleId, { linkedGarminActivityId: null, matchSource: null });
    },
  };
}

export type LinkService = ReturnType<typeof createLinkService>;
