import { headers } from "next/headers";
import { getDb } from "../lib/db";
import { getEnv } from "../lib/env";
import { isHostAllowed } from "../lib/http";
import { getSetupStatus, loadSetupCounts, NOT_READY, type SetupStatus } from "../modules/setup";

// Never throws: a broken environment is reported as "not ready" so every page still renders.
// Returns null for a disallowed Host so the shell shows no status there.
export async function loadSetupStatus(): Promise<SetupStatus | null> {
  try {
    const env = getEnv();
    if (!isHostAllowed((await headers()).get("host"), env.ALLOWED_HOSTS)) return null;
    return getSetupStatus(env, await loadSetupCounts(getDb()));
  } catch {
    return getSetupStatus({}, NOT_READY);
  }
}
