import { IntervalsConfigError } from "./errors";

export interface IntervalsConfig {
  readonly apiKey: string;
  readonly athleteId: string;
}

export function loadIntervalsConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): IntervalsConfig {
  const apiKey = env.INTERVALS_API_KEY?.trim();
  if (!apiKey) throw new IntervalsConfigError("INTERVALS_API_KEY");
  return { apiKey, athleteId: env.INTERVALS_ATHLETE_ID || "0" };
}
