import { format, inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSync } from "../src/modules/activities/index";
import { syncActivities } from "../src/modules/activities/sync";
import {
  buildGrid,
  createScheduleService,
  handleReschedule,
  handleSchedule,
  handleUnschedule,
  loadCalendar,
  PublisherError,
  type ScheduleService,
} from "../src/modules/calendar/index";
import {
  createGarminClient,
  GarminAuthError,
  type GarminClient,
  GarminServerError,
} from "../src/modules/garmin/index";
import { createIntervalsClient } from "../src/modules/intervals/index";
import {
  createWorkoutRepository,
  handleCreate,
  handleDelete,
  type WorkoutRepository,
} from "../src/modules/workouts/index";
import { createTestDb, type TestDb } from "./db-helpers";
import { createFakePublisher } from "./fake-publisher";
import {
  KEY as GARMIN_KEY,
  activity as garminActivity,
  reply as garminReply,
  JWT,
} from "./garmin-helpers";
import {
  BASIC,
  KEY as INTERVALS_KEY,
  reply,
  TOKEN,
  input as workoutInput,
} from "./intervals-helpers";

const SECRET = "fake-secret-1111";
const HOST = "localhost:3100";
const headers = { host: HOST, "content-type": "application/json" };

class LeakyError extends Error {
  override readonly name = "LeakyError";
  override toString(): string {
    return SECRET;
  }
}

// [label, factory, class name the code may log]
const thrown: [string, () => unknown, string][] = [
  ["secret in message", () => new Error(`Bearer ${SECRET}`), "Error"],
  ["secret in cause", () => new Error("outer", { cause: new Error(SECRET) }), "Error"],
  [
    "secret in stack",
    () =>
      Object.assign(new TypeError("x"), { stack: `TypeError: x\n    at leak (${SECRET}.ts:1:1)` }),
    "TypeError",
  ],
  ["string", () => `API_KEY:${SECRET}`, "UnknownError"],
  [
    "plain object",
    () => ({ message: SECRET, stack: SECRET, toString: () => SECRET }),
    "UnknownError",
  ],
  ["error subclass with toString", () => new LeakyError(`key ${SECRET}`), "LeakyError"],
];

let output: string[] = [];
const sink = (...args: unknown[]) => {
  output.push(format(...args));
};
beforeEach(() => {
  output = [];
  for (const m of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, m).mockImplementation(sink);
  }
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

const stackFrame = /\n\s+at \S/;
function expectNoSecret(text: string, secrets: readonly string[] = [SECRET]): void {
  for (const s of secrets) expect(text).not.toContain(s);
}
function expectClean(text: string, secrets: readonly string[] = [SECRET]): void {
  expectNoSecret(text, secrets);
  expect(text).not.toMatch(stackFrame);
}

const cast = <T>(partial: object): T => partial as unknown as T;
const service = (fail: () => Promise<never>) =>
  cast<ScheduleService>({ schedule: fail, reschedule: fail, unschedule: fail });
const repo = (fail: () => Promise<never>) =>
  cast<WorkoutRepository>({ create: fail, delete: fail });
const request = (method: string, body?: unknown) =>
  new Request(`http://${HOST}/api/x`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

type Route = [string, string, string, (fail: () => Promise<never>) => Promise<Response>];
const routes: Route[] = [
  [
    "sync",
    "sync failed",
    "sync failed",
    (fail) =>
      handleSync(request("POST"), {
        db: () => cast<TestDb["db"]>({}),
        garmin: () => cast<GarminClient>({}),
        sync: fail,
      }),
  ],
  [
    "schedule POST",
    "schedule request failed",
    "internal error",
    (fail) =>
      handleSchedule(request("POST", { workoutId: "w", date: "2026-06-20" }), {
        readService: () => service(fail),
        service: () => service(fail),
      }),
  ],
  [
    "schedule PATCH",
    "schedule request failed",
    "internal error",
    (fail) =>
      handleReschedule(request("PATCH", { date: "2026-06-20" }), "id", {
        readService: () => service(fail),
        service: () => service(fail),
      }),
  ],
  [
    "schedule DELETE",
    "schedule request failed",
    "internal error",
    (fail) =>
      handleUnschedule(request("DELETE"), "id", {
        readService: () => service(fail),
        service: () => service(fail),
      }),
  ],
  [
    "workouts POST",
    "workout request failed",
    "internal error",
    (fail) => handleCreate(request("POST", {}), { repo: () => repo(fail) }),
  ],
  [
    "workouts DELETE",
    "workout request failed",
    "internal error",
    (fail) => handleDelete(request("DELETE"), "id", { repo: () => repo(fail) }),
  ],
];

describe("log redaction: HTTP layers", () => {
  describe.each(routes)("%s", (_name, prefix, publicError, run) => {
    it.each(thrown)(
      "redaction: unknown error with %s gives a generic 500 and one constant log line",
      async (_l, make, errName) => {
        const res = await run(() => Promise.reject(make()));
        const body = await res.text();
        expect(res.status).toBe(500);
        expect(JSON.parse(body)).toEqual({ error: publicError });
        expectClean(body);
        expect(output).toEqual([`${prefix}: ${errName}`]);
        expect(console.error).toHaveBeenCalledTimes(1);
        expect(console.error).toHaveBeenCalledWith(`${prefix}: ${errName}`);
      },
    );
  });
});

type Scenario = [string, () => Promise<unknown>];
const causeChain = (e: unknown): unknown[] => {
  const seen: unknown[] = [];
  for (let c = e; c !== undefined && seen.length < 10 && !seen.includes(c); ) {
    seen.push(c);
    c = c instanceof Error ? c.cause : undefined;
  }
  return seen;
};
const surfaces = (e: unknown): string =>
  causeChain(e)
    .flatMap((c) => [
      c instanceof Error ? c.message : "",
      c instanceof Error ? (c.stack ?? "") : "",
      String(c),
      JSON.stringify(c),
      inspect(c, { depth: null, showHidden: true }),
    ])
    .join("\n");
const failure = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail");
};

const intervals = (fetch: typeof globalThis.fetch) =>
  createIntervalsClient({ apiKey: INTERVALS_KEY, athleteId: "0", fetch });
const garmin = (fetch: typeof globalThis.fetch) =>
  createGarminClient({ apiKey: GARMIN_KEY, fetch, now: () => 0 });
const echoed = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { authorization: BASIC, "x-echo": `${INTERVALS_KEY} ${GARMIN_KEY} Bearer ${JWT}` },
  });

const intervalsScenarios: Scenario[] = [
  [
    "401 echoing Authorization",
    () => intervals(async () => echoed(401, `Authorization: ${BASIC}`)).createWorkout(workoutInput),
  ],
  [
    "500 json body with key",
    () =>
      intervals(async () => reply(500, { key: INTERVALS_KEY, token: TOKEN })).createWorkout(
        workoutInput,
      ),
  ],
  [
    "network error with key",
    () =>
      intervals(() => Promise.reject(new Error(`${BASIC} ${INTERVALS_KEY}`))).createWorkout(
        workoutInput,
      ),
  ],
  [
    "delete 500 echoing key",
    () => intervals(async () => reply(500, INTERVALS_KEY)).deleteWorkout(7),
  ],
];
const garminScenarios: Scenario[] = [
  [
    "token 401 echoing key",
    () => garmin(async () => echoed(401, `ApiKey ${GARMIN_KEY}`)).listActivities(),
  ],
  [
    "list 500 echoing token and key",
    () => {
      const f = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(garminReply(200, JWT))
        .mockResolvedValue(echoed(500, `Bearer ${JWT} ApiKey ${GARMIN_KEY} {"k":"${GARMIN_KEY}"}`));
      return garmin(f).listActivities();
    },
  ],
  [
    "network error with key",
    () =>
      garmin(() =>
        Promise.reject(new TypeError(`ApiKey ${GARMIN_KEY} Bearer ${JWT}`)),
      ).listActivities(),
  ],
];

describe("log redaction: integration clients", () => {
  it.each(intervalsScenarios)("redaction: intervals %s", async (_n, run) => {
    const err = await failure(run);
    expectNoSecret(surfaces(err), [INTERVALS_KEY, TOKEN, BASIC, GARMIN_KEY, JWT]);
    expectClean(output.join("\n"), [INTERVALS_KEY, TOKEN, BASIC]);
    expect(output).toEqual([]);
  });

  it.each(garminScenarios)("redaction: garmin %s", async (_n, run) => {
    const err = await failure(run);
    expectNoSecret(surfaces(err), [GARMIN_KEY, JWT, INTERVALS_KEY, TOKEN, BASIC]);
    expect(output).toEqual([]);
  });
});

describe("log redaction: persisted error columns", () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => t.cleanup());

  const syncFailures: [string, () => unknown, string][] = [
    [
      "api error with detail",
      () => new GarminServerError(500, "GET", "/p", SECRET),
      "GarminServerError (500)",
    ],
    [
      "auth error with detail",
      () => new GarminAuthError(401, "GET", "/p", SECRET),
      "GarminAuthError (401)",
    ],
    ["plain error", () => new Error(`Bearer ${SECRET}`), "Error"],
    ["string", () => `API_KEY:${SECRET}`, "UnknownError"],
    ["error subclass with toString", () => new LeakyError(SECRET), "LeakyError"],
  ];
  it.each(syncFailures)(
    "redaction: SyncRun.errorMessage stores only the class for %s",
    async (_n, make, expected) => {
      const fail = () => Promise.reject(make());
      const garminStub = cast<GarminClient>({ listActivities: fail });
      const result = await syncActivities({ garmin: garminStub, db: t.db, sleep: async () => {} });
      const [row] = await t.db.syncRun.findMany();
      expect(result.status).toBe("failed");
      expect(row?.errorMessage).toBe(expected);
      expect(result.errorMessage).toBe(expected);
      expectClean(JSON.stringify(row));
      expect(output).toEqual([]);
    },
  );

  it("redaction: a failing activity download does not store the message either", async () => {
    const stub = cast<GarminClient>({
      listActivities: async () => [
        {
          ...garminActivity,
          garminActivityId: "1001",
          name: "n",
          sport: "run",
          startTime: new Date(0),
          durationSeconds: 1,
          distanceMeters: 1,
        },
      ],
      downloadActivityFit: () => Promise.reject(new GarminServerError(500, "GET", "/p", SECRET)),
    });
    await syncActivities({ garmin: stub, db: t.db, sleep: async () => {} });
    expectClean(JSON.stringify(await t.db.syncRun.findMany()));
  });

  const publishFailures: [string, () => Error, string][] = [
    ["publisher error with message", () => new PublisherError(SECRET, 502), "PublisherError (502)"],
    ["plain error", () => new Error(`Bearer ${SECRET}`), "Error"],
    ["error subclass with toString", () => new LeakyError(SECRET), "LeakyError"],
  ];
  it.each(publishFailures)(
    "redaction: ScheduledWorkout.lastError and the calendar view expose only the class for %s",
    async (_n, make, expected) => {
      const publisher = createFakePublisher();
      publisher.failNext("publish", make(), 10);
      const svc = createScheduleService({
        db: t.db,
        publisher,
        now: () => new Date("2026-06-15T10:00:00Z"),
        sleep: async () => {},
      });
      const w = await createWorkoutRepository(t.db).create({
        name: "Easy",
        sport: "run",
        steps: [
          { kind: "work", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 2 } },
        ],
      });
      const scheduled = await svc.schedule(w.id, "2026-06-20");
      const [row] = await t.db.scheduledWorkout.findMany();
      expect(scheduled.status).toBe("failed");
      expect(row?.lastError).toBe(expected);
      expect(scheduled.lastError).toBe(expected);
      expectClean(JSON.stringify(row));

      const data = await loadCalendar(
        t.db,
        () => svc,
        buildGrid("week", "2026-06-17"),
        "2026-06-17",
      );
      expect(data.days["2026-06-20"]?.scheduled[0]?.lastError).toBe(expected);
      expectClean(JSON.stringify(data));
      expect(output).toEqual([]);
    },
  );

  it("redaction: a failed remote removal records the class and throws a message without the secret", async () => {
    const publisher = createFakePublisher();
    const svc = createScheduleService({
      db: t.db,
      publisher,
      now: () => new Date("2026-06-15T10:00:00Z"),
      sleep: async () => {},
    });
    const w = await createWorkoutRepository(t.db).create({
      name: "Easy",
      sport: "run",
      steps: [
        { kind: "work", end: { type: "time", seconds: 600 }, target: { type: "hr", zone: 2 } },
      ],
    });
    const { id } = await svc.schedule(w.id, "2026-06-20");
    publisher.failNext("remove", new Error(`Bearer ${SECRET}`));
    const err = await failure(() => svc.unschedule(id));
    expectNoSecret(surfaces(err));
    expect((await t.db.scheduledWorkout.findUnique({ where: { id } }))?.lastError).toBe("Error");
  });
});
