import {
  IntervalsApiError,
  type IntervalsClient,
  IntervalsForeignEventError,
  IntervalsNotFoundError,
  IntervalsResponseError,
  IntervalsValidationError,
  type WorkoutTarget,
} from "../intervals";
import type { TargetType } from "../workouts";
import { scheduleWindow } from "./dates";
import {
  PublisherAuthError,
  PublisherForeignEventError,
  PublisherNotFoundError,
  PublisherRateLimitError,
  PublisherRejectedError,
  PublisherTransientError,
  type WorkoutPublisher,
} from "./publisher";

const TARGETS: Record<TargetType, WorkoutTarget> = { hr: "HR", pace: "PACE", power: "POWER" };

function mapError(err: unknown): unknown {
  if (err instanceof IntervalsForeignEventError) return new PublisherForeignEventError();
  if (err instanceof IntervalsNotFoundError) return new PublisherNotFoundError();
  if (err instanceof IntervalsApiError) {
    const { status } = err;
    if (status === 401 || status === 403) return new PublisherAuthError(status);
    if (status === 429) return new PublisherRateLimitError();
    if (status === 0 || status >= 500) return new PublisherTransientError(status || undefined);
    return new PublisherRejectedError(status);
  }
  if (err instanceof IntervalsValidationError || err instanceof IntervalsResponseError) {
    return new PublisherRejectedError();
  }
  return err;
}

const parseRemoteId = (remoteId: string): number => {
  const id = Number(remoteId);
  if (!/^[1-9]\d*$/.test(remoteId) || !Number.isSafeInteger(id)) {
    throw new PublisherNotFoundError();
  }
  return id;
};

async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw mapError(err);
  }
}

// Delete and reschedule rely on the client's default ownership guard; there is no bypass path here.
export function createIntervalsPublisher(
  client: IntervalsClient,
  options: { readonly now?: () => Date } = {},
): WorkoutPublisher {
  const now = options.now ?? (() => new Date());
  return {
    async publish(input) {
      const existing = await guarded(() =>
        client.findWorkoutByExternalId(input.externalId, scheduleWindow(now())),
      );
      if (existing) {
        if (existing.startDateLocal.slice(0, 10) !== input.date) {
          await guarded(() => client.rescheduleWorkout(existing.id, input.date));
        }
        return { remoteId: String(existing.id) };
      }
      const event = await guarded(() =>
        client.createWorkout({
          name: input.name,
          date: input.date,
          type: "Run",
          target: TARGETS[input.target],
          description: input.text,
          externalId: input.externalId,
        }),
      );
      return { remoteId: String(event.id) };
    },

    async reschedule(remoteId, date) {
      const id = parseRemoteId(remoteId);
      await guarded(() => client.rescheduleWorkout(id, date));
    },

    async remove(remoteId) {
      const id = parseRemoteId(remoteId);
      await guarded(() => client.deleteWorkout(id));
    },
  };
}
