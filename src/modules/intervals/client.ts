import {
  IntervalsApiError,
  IntervalsForeignEventError,
  IntervalsNotFoundError,
  IntervalsResponseError,
  IntervalsValidationError,
} from "./errors.js";

export type WorkoutTarget = "HR" | "PACE" | "POWER" | "AUTO";

export interface CreateWorkoutInput {
  readonly name: string;
  readonly date: string;
  readonly type: string;
  readonly target: WorkoutTarget;
  readonly description: string;
  readonly externalId: string;
}

export interface IntervalsEvent {
  readonly id: number;
  readonly externalId: string | null;
  readonly startDateLocal: string;
  readonly pushErrors: readonly unknown[] | null;
}

export const OWNED_EXTERNAL_ID_PREFIX = "wristplan-";

const hasOwnedPrefix = (externalId: string): boolean =>
  externalId.length > OWNED_EXTERNAL_ID_PREFIX.length &&
  externalId.startsWith(OWNED_EXTERNAL_ID_PREFIX);

export const isOwnedEvent = (event: Pick<IntervalsEvent, "externalId">): boolean =>
  event.externalId !== null && hasOwnedPrefix(event.externalId);

export interface DeleteWorkoutOptions {
  readonly allowForeign?: boolean;
}

export interface IntervalsClient {
  createWorkout(input: CreateWorkoutInput): Promise<IntervalsEvent>;
  rescheduleWorkout(eventId: number, date: string): Promise<IntervalsEvent>;
  deleteWorkout(eventId: number, options?: DeleteWorkoutOptions): Promise<void>;
}

export interface IntervalsClientOptions {
  readonly apiKey: string;
  readonly athleteId: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

type Json = Record<string, unknown>;

const DEFAULT_BASE_URL = "https://intervals.icu/api/v1";
const MAX_DETAIL = 200;
const DEFAULT_TIMEOUT_MS = 30_000;

const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function assertDate(date: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [y, m, d] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  const valid =
    match !== null &&
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === d;
  if (!valid) throw new IntervalsValidationError("date must be a valid YYYY-MM-DD");
}

function assertSameId(method: string, path: string, requested: number, actual: number): void {
  if (actual !== requested)
    throw new IntervalsResponseError(method, path, "id does not match request");
}

function assertEventId(eventId: number): void {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    throw new IntervalsValidationError("eventId must be a positive integer");
  }
}

function parseEvent(method: string, path: string, raw: unknown): IntervalsEvent {
  const fail = (reason: string) => new IntervalsResponseError(method, path, reason);
  if (!isRecord(raw)) throw fail("body is not an object");
  const { id, external_id, start_date_local, push_errors } = raw;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw fail("id is not a positive integer");
  }
  if (external_id !== null && external_id !== undefined && typeof external_id !== "string") {
    throw fail("external_id is not a string");
  }
  if (typeof start_date_local !== "string") throw fail("start_date_local is not a string");
  if (push_errors !== null && push_errors !== undefined && !Array.isArray(push_errors)) {
    throw fail("push_errors is not an array");
  }
  return {
    id,
    externalId: external_id ?? null,
    startDateLocal: start_date_local,
    pushErrors: push_errors && push_errors.length > 0 ? push_errors : null,
  };
}

export function createIntervalsClient(options: IntervalsClientOptions): IntervalsClient {
  const { apiKey, athleteId } = options;
  if (!apiKey.trim()) throw new IntervalsValidationError("apiKey is required");
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!/^[A-Za-z0-9_-]+$/.test(athleteId)) {
    throw new IntervalsValidationError("athleteId must match [A-Za-z0-9_-]+");
  }
  const token = Buffer.from(`API_KEY:${apiKey}`).toString("base64");
  const authorization = `Basic ${token}`;
  const eventsPath = `/athlete/${athleteId}/events`;

  const redact = (text: string): string =>
    text
      .split(apiKey)
      .join("[REDACTED]")
      .split(token)
      .join("[REDACTED]")
      .replace(/basic\s+[A-Za-z0-9+/=]+/gi, "[REDACTED]")
      // scheme words without a token (e.g. WWW-Authenticate realm) must not survive either
      .replace(/basic\s/gi, "[REDACTED] ")
      .slice(0, MAX_DETAIL);

  async function request(
    method: string,
    path: string,
    body?: unknown,
    parseBody = true,
  ): Promise<unknown> {
    const safePath = path.split("?")[0] as string;
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch {
      throw new IntervalsApiError(0, method, safePath, "network error");
    }
    if (res.status === 404) throw new IntervalsNotFoundError(method, safePath, redact(text));
    if (!res.ok) throw new IntervalsApiError(res.status, method, safePath, redact(text));
    if (!parseBody || text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new IntervalsResponseError(method, safePath, "body is not valid JSON");
    }
  }

  const toEventPath = (eventId: number) => `${eventsPath}/${eventId}`;

  return {
    async createWorkout(input) {
      assertDate(input.date);
      if (typeof input.externalId !== "string" || !input.externalId) {
        throw new IntervalsValidationError("externalId is required");
      }
      if (!hasOwnedPrefix(input.externalId)) {
        throw new IntervalsValidationError(
          `externalId must start with ${OWNED_EXTERNAL_ID_PREFIX} followed by a suffix`,
        );
      }
      const path = `${eventsPath}?upsertOnUid=true`;
      const raw = await request("POST", path, {
        category: "WORKOUT",
        type: input.type,
        name: input.name,
        start_date_local: `${input.date}T00:00:00`,
        target: input.target,
        description: input.description,
        external_id: input.externalId,
      });
      return parseEvent("POST", eventsPath, raw);
    },

    async rescheduleWorkout(eventId, date) {
      assertEventId(eventId);
      assertDate(date);
      const path = toEventPath(eventId);
      const current = await request("GET", path);
      const existing = parseEvent("GET", path, current);
      assertSameId("GET", path, eventId, existing.id);
      if (!isOwnedEvent(existing)) throw new IntervalsForeignEventError(eventId);
      const raw = await request("PUT", path, {
        ...(current as Json),
        start_date_local: `${date}T00:00:00`,
      });
      return parseEvent("PUT", path, raw);
    },

    async deleteWorkout(eventId, options) {
      assertEventId(eventId);
      const allowForeign =
        typeof options === "object" &&
        options !== null &&
        Object.hasOwn(options, "allowForeign") &&
        options.allowForeign === true;
      if (!allowForeign) {
        const path = toEventPath(eventId);
        const existing = parseEvent("GET", path, await request("GET", path));
        assertSameId("GET", path, eventId, existing.id);
        if (!isOwnedEvent(existing)) throw new IntervalsForeignEventError(eventId);
      }
      await request("DELETE", toEventPath(eventId), undefined, false);
    },
  };
}
