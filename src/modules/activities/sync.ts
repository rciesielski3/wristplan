import type { Db } from "../../lib/db";
import {
  type GarminActivity,
  GarminApiError,
  GarminAuthError,
  type GarminClient,
  GarminNetworkError,
  GarminRateLimitError,
  GarminServerError,
} from "../garmin";

export const STALE_RUN_MS = 30 * 60 * 1000;
export const MAX_RETRY_AFTER_SECONDS = 60;
export const MAX_TRANSIENT_RETRIES = 2;
const BACKOFF_BASE_MS = 1000;
const DEFAULT_PAGE_SIZE = 100;

export class SyncInProgressError extends Error {
  override readonly name = "SyncInProgressError";
  constructor() {
    super("an activity sync is already running");
  }
}

export interface SyncActivitiesOptions {
  readonly garmin: GarminClient;
  readonly db: Db;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pageSize?: number;
  readonly startDate?: string;
  readonly endDate?: string;
}

export interface SyncResult {
  readonly runId: string;
  readonly status: "succeeded" | "failed";
  readonly imported: number;
  readonly updated: number;
  readonly failed: number;
  readonly errorMessage: string | null;
}

// Error class and status only: raw messages carry request paths and must not reach the db.
function redact(err: unknown): string {
  if (err instanceof GarminApiError) return `${err.name} (${err.status})`;
  return err instanceof Error ? err.name : "UnknownError";
}

function isFatal(err: unknown): boolean {
  return (
    err instanceof GarminAuthError ||
    err instanceof GarminRateLimitError ||
    err instanceof GarminServerError ||
    err instanceof GarminNetworkError
  );
}

export async function syncActivities(options: SyncActivitiesOptions): Promise<SyncResult> {
  const { garmin, db } = options;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  const run = await db.$transaction(async (tx) => {
    const at = now();
    await tx.syncRun.updateMany({
      where: { status: "running", startedAt: { lt: new Date(at.getTime() - STALE_RUN_MS) } },
      data: { status: "failed", finishedAt: at, errorMessage: "interrupted (stale run)" },
    });
    if ((await tx.syncRun.count({ where: { status: "running" } })) > 0) {
      throw new SyncInProgressError();
    }
    return tx.syncRun.create({ data: { startedAt: at, status: "running" } });
  });

  let imported = 0;
  let updated = 0;
  let failed = 0;
  let errorMessage: string | null = null;

  async function withRetry<T>(
    rateLimitUsed: { value: boolean },
    call: () => Promise<T>,
  ): Promise<T> {
    for (let transient = 0; ; ) {
      try {
        return await call();
      } catch (err) {
        if (err instanceof GarminRateLimitError) {
          const wait = err.retryAfterSeconds;
          if (rateLimitUsed.value || wait === undefined || wait > MAX_RETRY_AFTER_SECONDS)
            throw err;
          rateLimitUsed.value = true;
          await sleep(wait * 1000);
        } else if (
          (err instanceof GarminServerError || err instanceof GarminNetworkError) &&
          transient < MAX_TRANSIENT_RETRIES
        ) {
          await sleep(BACKOFF_BASE_MS * 2 ** transient);
          transient += 1;
        } else {
          throw err;
        }
      }
    }
  }

  async function syncOne(item: GarminActivity, rateLimit: { value: boolean }): Promise<void> {
    const existing = await db.activity.findUnique({
      where: { garminActivityId: item.garminActivityId },
      select: { fitDownloadedAt: true },
    });
    let fit: Uint8Array<ArrayBuffer> | undefined;
    let fitFailed = false;
    if (existing?.fitDownloadedAt == null) {
      try {
        const bytes = await withRetry(rateLimit, () =>
          garmin.downloadActivityFit(item.garminActivityId),
        );
        fit = Uint8Array.from(bytes);
      } catch (err) {
        if (isFatal(err)) throw err;
        fitFailed = true;
      }
    }
    const at = now();
    const fields = {
      name: item.name,
      sport: item.sport,
      startTime: item.startTime,
      durationSeconds: item.durationSeconds,
      distanceMeters: item.distanceMeters,
      syncStatus: fitFailed ? "failed" : "synced",
      lastSyncedAt: at,
      ...(fit ? { fitFile: fit, fitDownloadedAt: at } : {}),
    };
    await db.activity.upsert({
      where: { garminActivityId: item.garminActivityId },
      create: { garminActivityId: item.garminActivityId, createdAt: at, ...fields },
      update: fields,
    });
    if (existing) updated += 1;
    else imported += 1;
    if (fitFailed) failed += 1;
  }

  const seen = new Set<string>();
  try {
    for (let start = 0; ; start += pageSize) {
      const rateLimit = { value: false };
      const page = await withRetry(rateLimit, () =>
        garmin.listActivities({
          start,
          limit: pageSize,
          sortOrder: "asc",
          ...(options.startDate !== undefined ? { startDate: options.startDate } : {}),
          ...(options.endDate !== undefined ? { endDate: options.endDate } : {}),
        }),
      );
      let fresh = 0;
      for (const item of page) {
        if (seen.has(item.garminActivityId)) continue;
        seen.add(item.garminActivityId);
        fresh += 1;
        await syncOne(item, rateLimit);
      }
      // A page with nothing new means the API ignores `start`; stop instead of looping forever.
      if (page.length < pageSize || fresh === 0) break;
    }
  } catch (err) {
    errorMessage = redact(err);
  }

  const status = errorMessage === null ? "succeeded" : "failed";
  await db.syncRun.update({
    where: { id: run.id },
    data: { status, finishedAt: now(), imported, updated, failed, errorMessage },
  });
  return { runId: run.id, status, imported, updated, failed, errorMessage };
}
