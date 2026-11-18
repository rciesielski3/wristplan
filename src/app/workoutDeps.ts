import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getDb } from "../lib/db";
import { getEnv } from "../lib/env";
import { isHostAllowed } from "../lib/http";
import { createWorkoutRepository, type WorkoutRouteDeps } from "../modules/workouts";

export const workoutDeps = (): WorkoutRouteDeps => ({
  repo: () => createWorkoutRepository(getDb()),
  allowedHosts: getEnv().ALLOWED_HOSTS,
});

export async function requireAllowedHost(): Promise<void> {
  if (!isHostAllowed((await headers()).get("host"), getEnv().ALLOWED_HOSTS)) notFound();
}
