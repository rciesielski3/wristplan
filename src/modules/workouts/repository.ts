import type { Db } from "../../lib/db";
import { LIMITS, type Workout } from "./model";
import { parseWorkout, validateWorkout } from "./validate";

export const WORKOUT_LIST_LIMIT = 200;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COPY_SUFFIX = " (copy)";
const NOT_FOUND_CODE = "P2025";

export class WorkoutNotFoundError extends Error {
  override readonly name = "WorkoutNotFoundError";
  constructor(readonly id?: string) {
    super(id === undefined ? "Workout not found: invalid id" : `Workout not found: ${id}`);
  }
}

export class WorkoutCorruptError extends Error {
  override readonly name = "WorkoutCorruptError";
  constructor(readonly id: string) {
    super(`Stored workout is corrupt: ${id}`);
  }
}

export class WorkoutNotTemplateError extends Error {
  override readonly name = "WorkoutNotTemplateError";
  constructor(readonly id: string) {
    super(`Workout is not a template: ${id}`);
  }
}

export interface StoredWorkout {
  readonly id: string;
  readonly isTemplate: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly workout: Workout;
}

export interface WorkoutList {
  readonly items: readonly StoredWorkout[];
  readonly corruptIds: readonly string[];
}

interface Row {
  id: string;
  definition: string;
  isTemplate: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const checkId = (id: string): string => {
  // typeof: RegExp.test coerces, so 123 or ["abc"] would otherwise reach Prisma and leak its error.
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new WorkoutNotFoundError();
  return id;
};

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === NOT_FOUND_CODE;

const decode = (row: Row): StoredWorkout => {
  let raw: unknown;
  try {
    raw = JSON.parse(row.definition);
  } catch {
    throw new WorkoutCorruptError(row.id);
  }
  const result = validateWorkout(raw);
  if (!result.ok) throw new WorkoutCorruptError(row.id);
  return {
    id: row.id,
    isTemplate: row.isTemplate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    workout: result.workout,
  };
};

// Cuts by UTF-16 units like the name limit does, without leaving half a surrogate pair.
const copyName = (name: string): string => {
  const room = LIMITS.nameMaxLength - COPY_SUFFIX.length;
  if (name.length <= room) return name + COPY_SUFFIX;
  let base = name.slice(0, room);
  const last = base.charCodeAt(base.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) base = base.slice(0, -1);
  return base.trimEnd() + COPY_SUFFIX;
};

export function createWorkoutRepository(db: Db) {
  const find = async (id: string): Promise<StoredWorkout> => {
    const row = await db.workout.findUnique({ where: { id: checkId(id) } });
    if (!row) throw new WorkoutNotFoundError(id);
    return decode(row);
  };

  const insert = async (workout: Workout, isTemplate: boolean): Promise<StoredWorkout> =>
    decode(await db.workout.create({ data: { definition: JSON.stringify(workout), isTemplate } }));

  const copy = (source: StoredWorkout, name: string | undefined, isTemplate: boolean) =>
    insert(
      parseWorkout({ ...source.workout, name: name ?? copyName(source.workout.name) }),
      isTemplate,
    );

  return {
    async create(input: unknown, options: { isTemplate?: boolean } = {}): Promise<StoredWorkout> {
      return insert(parseWorkout(input), options.isTemplate ?? false);
    },

    get: find,

    // Corrupt rows are skipped and reported in corruptIds so one bad row never breaks the list.
    async list(options: { templates?: boolean; limit?: number } = {}): Promise<WorkoutList> {
      const requested = Math.trunc(options.limit ?? Number.NaN);
      const take = Number.isNaN(requested)
        ? WORKOUT_LIST_LIMIT
        : Math.min(Math.max(requested, 1), WORKOUT_LIST_LIMIT);
      const rows = await db.workout.findMany({
        where: options.templates === undefined ? {} : { isTemplate: options.templates },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take,
      });
      const items: StoredWorkout[] = [];
      const corruptIds: string[] = [];
      for (const row of rows) {
        try {
          items.push(decode(row));
        } catch (error) {
          if (!(error instanceof WorkoutCorruptError)) throw error;
          corruptIds.push(row.id);
        }
      }
      return { items, corruptIds };
    },

    async update(
      id: string,
      input: unknown,
      options: { isTemplate?: boolean } = {},
    ): Promise<StoredWorkout> {
      const workout = parseWorkout(input);
      try {
        const row = await db.workout.update({
          where: { id: checkId(id) },
          data: {
            definition: JSON.stringify(workout),
            ...(options.isTemplate === undefined ? {} : { isTemplate: options.isTemplate }),
          },
        });
        return decode(row);
      } catch (error) {
        if (isNotFound(error)) throw new WorkoutNotFoundError(id);
        throw error;
      }
    },

    async delete(id: string): Promise<void> {
      try {
        await db.workout.delete({ where: { id: checkId(id) } });
      } catch (error) {
        if (isNotFound(error)) throw new WorkoutNotFoundError(id);
        throw error;
      }
    },

    async duplicate(
      id: string,
      options: { name?: string; asTemplate?: boolean } = {},
    ): Promise<StoredWorkout> {
      return copy(await find(id), options.name, options.asTemplate ?? false);
    },

    async createFromTemplate(templateId: string, options: { name?: string } = {}) {
      const source = await find(templateId);
      if (!source.isTemplate) throw new WorkoutNotTemplateError(templateId);
      return copy(source, options.name ?? source.workout.name, false);
    },
  };
}

export type WorkoutRepository = ReturnType<typeof createWorkoutRepository>;
