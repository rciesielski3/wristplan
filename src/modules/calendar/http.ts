import { guarded as guard, HttpError, json, readJson } from "../../lib/http";
import { WorkoutCorruptError, WorkoutNotFoundError } from "../workouts";
import {
  ScheduleConflictError,
  ScheduleForeignEventError,
  ScheduleListOverflowError,
  ScheduleNotConfiguredError,
  ScheduleNotFoundError,
  SchedulePublishError,
  ScheduleValidationError,
} from "./errors";
import type { Schedule, ScheduleService } from "./schedule";

export interface ScheduleRouteDeps {
  // Reads must keep working without intervals.icu credentials; `service` throws
  // ScheduleNotConfiguredError when they are missing.
  readonly readService: () => ScheduleService;
  readonly service: () => ScheduleService;
  readonly allowedHosts?: string | undefined;
}

const serialize = (s: Schedule) => ({
  id: s.id,
  workoutId: s.workoutId,
  date: s.date,
  status: s.status,
  remoteEventId: s.remoteEventId,
  lastError: s.lastError,
  publishedAt: s.publishedAt?.toISOString() ?? null,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

// SchedulePublishError.reason starts with the publisher error class name.
function publishFailure(err: SchedulePublishError): Response {
  if (err.reason.startsWith("PublisherRateLimitError"))
    return json({ error: "intervals.icu rate limit reached; retry later" }, 429);
  if (err.reason.startsWith("PublisherAuthError"))
    return json({ error: "intervals.icu rejected the credentials" }, 502);
  return json({ error: "publishing to intervals.icu failed" }, 502);
}

function toResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.publicMessage }, err.status);
  if (err instanceof ScheduleValidationError) return json({ error: err.message }, 422);
  if (err instanceof ScheduleListOverflowError) return json({ error: err.message }, 422);
  if (err instanceof ScheduleNotFoundError) return json({ error: "not found" }, 404);
  if (err instanceof WorkoutNotFoundError) return json({ error: "workout not found" }, 404);
  if (err instanceof WorkoutCorruptError) return json({ error: "stored workout is corrupt" }, 409);
  if (err instanceof ScheduleConflictError) return json({ error: err.message }, 409);
  if (err instanceof ScheduleForeignEventError)
    return json({ error: "remote event was not created by wristplan" }, 409);
  if (err instanceof SchedulePublishError) return publishFailure(err);
  if (err instanceof ScheduleNotConfiguredError)
    return json({ error: "intervals.icu is not configured" }, 503);
  console.error(`schedule request failed: ${err instanceof Error ? err.name : "UnknownError"}`);
  return json({ error: "internal error" }, 500);
}

const guarded = (
  request: Request,
  deps: ScheduleRouteDeps,
  mutates: boolean,
  run: () => Promise<Response>,
) => guard(request, deps.allowedHosts, mutates, run, toResponse);

async function readFields(request: Request, ...keys: string[]): Promise<string[]> {
  const body = await readJson(request);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return keys.map((key) => {
    const value = record[key];
    if (typeof value !== "string") throw new ScheduleValidationError(`${key} must be a string`);
    return value;
  });
}

export function handleList(request: Request, deps: ScheduleRouteDeps): Promise<Response> {
  return guarded(request, deps, false, async () => {
    const params = new URL(request.url).searchParams;
    const items = await deps
      .readService()
      .list({ from: params.get("from") ?? "", to: params.get("to") ?? "" });
    return json({ items: items.map(serialize) }, 200);
  });
}

export function handleSchedule(request: Request, deps: ScheduleRouteDeps): Promise<Response> {
  return guarded(request, deps, true, async () => {
    const service = deps.service();
    const [workoutId, date] = await readFields(request, "workoutId", "date");
    return json(serialize(await service.schedule(workoutId as string, date as string)), 201);
  });
}

export function handleRetry(
  request: Request,
  id: string,
  deps: ScheduleRouteDeps,
): Promise<Response> {
  return guarded(request, deps, true, async () =>
    json(serialize(await deps.service().retry(id)), 200),
  );
}

export function handleReschedule(
  request: Request,
  id: string,
  deps: ScheduleRouteDeps,
): Promise<Response> {
  return guarded(request, deps, true, async () => {
    const service = deps.service();
    const [date] = await readFields(request, "date");
    return json(serialize(await service.reschedule(id, date as string)), 200);
  });
}

export function handleUnschedule(
  request: Request,
  id: string,
  deps: ScheduleRouteDeps,
): Promise<Response> {
  return guarded(request, deps, true, async () => {
    await deps.service().unschedule(id);
    return json({ ok: true }, 200);
  });
}
