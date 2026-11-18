import {
  PublisherForeignEventError,
  PublisherNotFoundError,
  type PublishInput,
  type WorkoutPublisher,
} from "../src/modules/calendar/index";

type Method = "publish" | "reschedule" | "remove";

export interface FakePublisher extends WorkoutPublisher {
  readonly calls: { method: Method; args: unknown[] }[];
  readonly remote: Map<string, { externalId: string; date: string; foreign: boolean }>;
  failNext(method: Method, error: Error, times?: number): void;
  seedForeign(date: string): string;
}

export function createFakePublisher(): FakePublisher {
  const remote = new Map<string, { externalId: string; date: string; foreign: boolean }>();
  const failures = new Map<Method, { error: Error; times: number }>();
  const calls: FakePublisher["calls"] = [];
  let next = 1;

  const enter = (method: Method, args: unknown[]) => {
    calls.push({ method, args });
    const failure = failures.get(method);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      throw failure.error;
    }
  };
  const find = (remoteId: string) => {
    const event = remote.get(remoteId);
    if (!event) throw new PublisherNotFoundError();
    if (event.foreign) throw new PublisherForeignEventError();
    return event;
  };

  return {
    calls,
    remote,
    failNext(method, error, times = 1) {
      failures.set(method, { error, times });
    },
    seedForeign(date) {
      const id = String(next++);
      remote.set(id, { externalId: "", date, foreign: true });
      return id;
    },
    async publish(input: PublishInput) {
      enter("publish", [input]);
      for (const [remoteId, event] of remote) {
        if (event.externalId === input.externalId) {
          event.date = input.date;
          return { remoteId };
        }
      }
      const remoteId = String(next++);
      remote.set(remoteId, { externalId: input.externalId, date: input.date, foreign: false });
      return { remoteId };
    },
    async reschedule(remoteId, date) {
      enter("reschedule", [remoteId, date]);
      find(remoteId).date = date;
    },
    async remove(remoteId) {
      enter("remove", [remoteId]);
      find(remoteId);
      remote.delete(remoteId);
    },
  };
}
