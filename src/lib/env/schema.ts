import { z } from "zod";

const blankAsAbsent = (value: unknown) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const text = <T extends z.ZodType>(schema: T) => z.preprocess(blankAsAbsent, schema);

export const envSchema = z.object({
  DATABASE_URL: text(
    z
      .string()
      .regex(/^file:\S/)
      .optional(),
  ),
  INTERVALS_API_KEY: text(z.string().optional()),
  GARMIN_PERSONAL_API_KEY: text(z.string().optional()),
  INTERVALS_ATHLETE_ID: text(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .default("0"),
  ),
  NODE_ENV: text(z.enum(["development", "test", "production"]).default("development")),
});

export type Env = z.infer<typeof envSchema>;
