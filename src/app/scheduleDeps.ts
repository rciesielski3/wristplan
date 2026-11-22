import { getDb } from "../lib/db";
import { getEnv } from "../lib/env";
import {
  createIntervalsPublisher,
  createLinkService,
  createScheduleService,
  type LinkRouteDeps,
  ScheduleNotConfiguredError,
  type ScheduleRouteDeps,
} from "../modules/calendar";
import { createIntervalsClient } from "../modules/intervals";

export const scheduleDeps = (): ScheduleRouteDeps & LinkRouteDeps => {
  const env = getEnv();
  return {
    allowedHosts: env.ALLOWED_HOSTS,
    linkService: () => createLinkService({ db: getDb() }),
    // list never touches the publisher, so it is safe without a key
    readService: () =>
      createScheduleService({
        db: getDb(),
        publisher: {
          publish: () => Promise.reject(new ScheduleNotConfiguredError()),
          reschedule: () => Promise.reject(new ScheduleNotConfiguredError()),
          remove: () => Promise.reject(new ScheduleNotConfiguredError()),
        },
      }),
    service: () => {
      if (!env.INTERVALS_API_KEY) throw new ScheduleNotConfiguredError();
      const client = createIntervalsClient({
        apiKey: env.INTERVALS_API_KEY,
        athleteId: env.INTERVALS_ATHLETE_ID,
      });
      return createScheduleService({ db: getDb(), publisher: createIntervalsPublisher(client) });
    },
  };
};
