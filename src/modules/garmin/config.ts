import { GarminConfigError } from "./errors";

export interface GarminConfig {
  readonly apiKey: string;
}

export function loadGarminConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GarminConfig {
  const apiKey = env.GARMIN_PERSONAL_API_KEY?.trim();
  if (!apiKey) throw new GarminConfigError("GARMIN_PERSONAL_API_KEY");
  return { apiKey };
}
