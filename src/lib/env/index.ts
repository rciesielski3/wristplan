import { type Env, envSchema } from "./schema";

export type { Env };

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

function isAbsent(source: unknown, key: PropertyKey | undefined): boolean {
  if (typeof source !== "object" || source === null || typeof key !== "string") return false;
  const value: unknown = Reflect.get(source, key);
  return value === undefined || (typeof value === "string" && value.trim() === "");
}

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const names = result.error.issues.map((issue) => {
    const name = issue.path.join(".") || "env";
    return `${name} (${isAbsent(source, issue.path[0]) ? "missing" : "invalid"})`;
  });
  throw new EnvError(`Invalid environment: ${names.join(", ")}`);
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv();
  return cached;
}
