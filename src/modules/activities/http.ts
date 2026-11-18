import type { Db } from "../../lib/db";
import { isHostAllowed, json, rejectCrossOrigin } from "../../lib/http";
import { type GarminClient, GarminConfigError } from "../garmin";
import { SyncInProgressError, type SyncResult, syncActivities } from "./sync";

export interface SyncRouteDeps {
  readonly db: () => Db;
  readonly garmin: () => GarminClient;
  readonly sync?: typeof syncActivities;
  readonly allowedHosts?: string | undefined;
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
