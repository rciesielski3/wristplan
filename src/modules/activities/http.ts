import type { Db } from "../../lib/db";
import { type GarminClient, GarminConfigError } from "../garmin";
import { SyncInProgressError, type SyncResult, syncActivities } from "./sync";

export interface SyncRouteDeps {
  readonly db: () => Db;
  readonly garmin: () => GarminClient;
  readonly sync?: typeof syncActivities;
  readonly allowedHosts?: string | undefined;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function hostname(host: string): string {
  const end = host.startsWith("[") ? host.indexOf("]") + 1 : host.indexOf(":");
  return (end > 0 ? host.slice(0, end) : host).toLowerCase();
}

// Defence against DNS rebinding: a rebound page carries a matching Origin but an attacker Host.
export function isHostAllowed(host: string | null, extra?: string): boolean {
  if (host === null) return false;
  const allowed = [
    ...LOOPBACK_HOSTS,
    ...(extra ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  ];
  return allowed.includes(hostname(host));
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// Browsers always send Origin on cross-origin POST, so only non-browser clients (curl) omit it;
// they cannot be driven by a web page, which is the CSRF threat for a local single-user app.
export function rejectCrossOrigin(request: Request, extraHosts?: string): Response | null {
  if (!isHostAllowed(request.headers.get("host"), extraHosts)) {
    return json({ error: "forbidden" }, 403);
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return json({ error: "forbidden" }, 403);
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {}
  if (originHost === null || originHost !== request.headers.get("host")) {
    return json({ error: "forbidden" }, 403);
  }
  return null;
}

export async function handleSync(request: Request, deps: SyncRouteDeps): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const blocked = rejectCrossOrigin(request, deps.allowedHosts);
  if (blocked) return blocked;
  try {
    const result: SyncResult = await (deps.sync ?? syncActivities)({
      garmin: deps.garmin(),
      db: deps.db(),
    });
    return json(result, 200);
  } catch (err) {
    if (err instanceof GarminConfigError) {
      return json({ error: "GARMIN_PERSONAL_API_KEY not configured" }, 503);
    }
    if (err instanceof SyncInProgressError) return json({ error: err.message }, 409);
    console.error(`sync failed: ${err instanceof Error ? err.name : "UnknownError"}`);
    return json({ error: "sync failed" }, 500);
  }
}

const NUMERIC_ID = /^\d+$/;

export async function handleFitDownload(
  request: Request,
  id: string,
  db: Db,
  allowedHosts?: string,
): Promise<Response> {
  if (!isHostAllowed(request.headers.get("host"), allowedHosts)) {
    return json({ error: "forbidden" }, 403);
  }
  if (!NUMERIC_ID.test(id)) return json({ error: "not found" }, 404);
  const row = await db.activity.findUnique({
    where: { garminActivityId: id },
    select: { fitFile: true },
  });
  if (!row?.fitFile) return json({ error: "not found" }, 404);
  return new Response(Uint8Array.from(row.fitFile), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${id}.fit"`,
      "Content-Length": String(row.fitFile.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
