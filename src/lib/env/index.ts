import { type Env, envSchema } from "./schema.js";

export type { Env };

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const names = result.error.issues.map((issue) => `${issue.path.join(".") || "env"} (invalid)`);
  throw new EnvError(`Invalid environment: ${names.join(", ")}`);
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv();
  return cached;
}
