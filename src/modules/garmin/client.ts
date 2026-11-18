import { z } from "zod";
import {
  GarminApiError,
  GarminAuthError,
  GarminNetworkError,
  GarminRateLimitError,
  GarminResponseError,
  GarminServerError,
  GarminValidationError,
} from "./errors";
import { extractSingleFit, type ZipError } from "./zip";

export interface GarminActivity {
  readonly garminActivityId: string;
  readonly name: string | null;
  readonly sport: string;
  readonly startTime: Date;
  readonly durationSeconds: number | null;
  readonly distanceMeters: number | null;
}

export interface ListActivitiesInput {
  readonly startDate?: string;
  readonly endDate?: string;
  readonly start?: number;
  readonly limit?: number;
  readonly sortOrder?: "asc" | "desc";
}

export interface GarminClient {
  listActivities(input?: ListActivitiesInput): Promise<readonly GarminActivity[]>;
  downloadActivityFit(activityId: string): Promise<Uint8Array>;
}

export interface GarminClientOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const DEFAULT_BASE_URL = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const LIST_PATH = "/activitylist-service/activities/search/activities";
const DOWNLOAD_PATH = "/download-service/files/activity";
const MAX_DETAIL = 200;
const DEFAULT_TIMEOUT_MS = 30_000;
// Tokens live 24h; refresh early so a token never expires mid-request.
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
const MAX_FIT_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_BYTES = MAX_FIT_BYTES;

const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const GMT_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;

const gmtTime = z.string().transform((s, ctx) => {
  const m = GMT_TIME.exec(s);
  const n = m ? m.slice(1, 7).map(Number) : [];
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, sec = 0] = n;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  if (!m || Number.isNaN(date.getTime()) || date.getUTCDate() !== d) {
    ctx.addIssue({ code: "custom", message: "invalid startTimeGMT" });
    return z.NEVER;
  }
  return date;
});

// zod object schemas strip unknown keys, which is what keeps PII out of the module.
const activitySchema = z
  .object({
    activityId: z.number().int().positive().safe(),
    activityName: z.string().nullish(),
    activityType: z.object({ typeKey: z.string() }),
    startTimeGMT: gmtTime,
    duration: z.number().nonnegative().nullish(),
    distance: z.number().nonnegative().nullish(),
  })
  .transform(
    (a): GarminActivity => ({
      garminActivityId: String(a.activityId),
      name: a.activityName ?? null,
      sport: a.activityType.typeKey,
      startTime: a.startTimeGMT,
      durationSeconds: a.duration ?? null,
      distanceMeters: a.distance ?? null,
    }),
  );

const isoDate = z.iso.date();
const listInputSchema = z.object({
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  start: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

interface Raw {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
}

export function createGarminClient(options: GarminClientOptions): GarminClient {
  // trimmed so redaction matches what actually goes on the wire
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new GarminValidationError("apiKey is required");
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  const redact = (text: string): string => {
    let out = text.split(apiKey).join("[REDACTED]");
    if (cached) out = out.split(cached.token).join("[REDACTED]");
    return out
      .replace(/\b(bearer|apikey)\s+\S+/gi, "[REDACTED]")
      .replace(/[\w-]+\.[\w-]+\.[\w-]+/g, "[REDACTED]")
      .slice(0, MAX_DETAIL);
  };

  async function send(
    method: string,
    path: string,
    query: string,
    authorization: string,
    accept: string,
  ): Promise<Raw> {
    try {
      const res = await doFetch(`${baseUrl}${path}${query}`, {
        method,
        headers: { Authorization: authorization, Accept: accept },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        status: res.status,
        headers: res.headers,
        bytes: new Uint8Array(await res.arrayBuffer()),
      };
    } catch (err) {
      throw new GarminNetworkError(
        method,
        path,
        err instanceof Error && err.name === "TimeoutError",
      );
    }
  }

  const text = (raw: Raw): string => new TextDecoder().decode(raw.bytes);

  function statusError(method: string, path: string, raw: Raw): GarminApiError {
    const detail = redact(text(raw));
    const { status } = raw;
    if (status === 401 || status === 403) return new GarminAuthError(status, method, path, detail);
    if (status === 429) {
      const header = raw.headers.get("retry-after")?.trim() ?? "";
      return new GarminRateLimitError(
        method,
        path,
        detail,
        /^\d{1,9}$/.test(header) ? Number(header) : undefined,
      );
    }
    if (status >= 500) return new GarminServerError(status, method, path, detail);
    return new GarminApiError(status, method, path, detail);
  }

  async function fetchToken(): Promise<string> {
    const method = "POST";
    const raw = await send(method, TOKEN_PATH, "", `ApiKey ${apiKey}`, "text/plain");
    if (raw.status < 200 || raw.status >= 300) throw statusError(method, TOKEN_PATH, raw);
    const token = text(raw).trim();
    if (!JWT_SHAPE.test(token)) {
      throw new GarminResponseError(method, TOKEN_PATH, "token response is not a JWT");
    }
    cached = { token, expiresAt: now() + TOKEN_TTL_MS };
    return token;
  }

  function getToken(): Promise<string> {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.token);
    pending ??= fetchToken().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  async function request(path: string, query: string, accept: string): Promise<Raw> {
    const method = "GET";
    let token = await getToken();
    let raw = await send(method, path, query, `Bearer ${token}`, accept);
    if (raw.status === 401) {
      if (cached?.token === token) cached = undefined;
      token = await getToken();
      raw = await send(method, path, query, `Bearer ${token}`, accept);
    }
    if (raw.status < 200 || raw.status >= 300) throw statusError(method, path, raw);
    return raw;
  }

  return {
    async listActivities(input = {}) {
      const parsed = listInputSchema.safeParse(input);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
        throw new GarminValidationError(`invalid list input: ${fields.join(", ")}`);
      }
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(parsed.data)) {
        if (v !== undefined) params.set(k, String(v));
      }
      const query = params.size > 0 ? `?${params}` : "";
      const raw = await request(LIST_PATH, query, "application/json");
      const fail = (reason: string) => new GarminResponseError("GET", LIST_PATH, reason);
      let body: unknown;
      try {
        body = JSON.parse(text(raw));
      } catch {
        throw fail("body is not valid JSON");
      }
      if (!Array.isArray(body)) throw fail("body is not an array");
      return body.map((item, i) => {
        const r = activitySchema.safeParse(item);
        if (!r.success) throw fail(`activity ${i} has an unexpected shape`);
        return r.data;
      });
    },

    async downloadActivityFit(activityId) {
      if (typeof activityId !== "string" || !/^\d{1,19}$/.test(activityId)) {
        throw new GarminValidationError("activityId must be digits only");
      }
      const path = `${DOWNLOAD_PATH}/${activityId}`;
      const raw = await request(path, "", "application/x-zip-compressed");
      if (raw.bytes.length > MAX_ZIP_BYTES) {
        throw new GarminResponseError("GET", path, "download exceeds size limit");
      }
      try {
        return extractSingleFit(raw.bytes, MAX_FIT_BYTES);
      } catch (err) {
        // extractSingleFit only throws ZipError (all reads are bounds-checked)
        throw new GarminResponseError("GET", path, (err as ZipError).message);
      }
    },
  };
}
