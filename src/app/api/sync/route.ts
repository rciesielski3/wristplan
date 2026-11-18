import { getDb } from "../../../lib/db";
import { getEnv } from "../../../lib/env";
import { handleSync } from "../../../modules/activities";
import { createGarminClient, loadGarminConfig } from "../../../modules/garmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleSync(request, {
    db: getDb,
    allowedHosts: getEnv().ALLOWED_HOSTS,
    garmin: () => createGarminClient(loadGarminConfig()),
  });
}
