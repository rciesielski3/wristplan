export class ScheduleValidationError extends Error {
  override readonly name = "ScheduleValidationError";
}

export class ScheduleNotFoundError extends Error {
  override readonly name = "ScheduleNotFoundError";
  constructor() {
    super("scheduled workout not found");
  }
}

export class ScheduleConflictError extends Error {
  override readonly name = "ScheduleConflictError";
  constructor() {
    super("this workout is already scheduled on that date");
  }
}

export class ScheduleForeignEventError extends Error {
  override readonly name = "ScheduleForeignEventError";
  constructor() {
    super("the remote event was not created by wristplan; refusing to change it");
  }
}

export type SchedulePublishFailureKind = "rate-limit" | "auth" | "other";

export class SchedulePublishError extends Error {
  override readonly name = "SchedulePublishError";
  constructor(
    readonly reason: string,
    readonly kind: SchedulePublishFailureKind = "other",
  ) {
    super(`publisher call failed: ${reason}`);
  }
}

export class ScheduleListOverflowError extends Error {
  override readonly name = "ScheduleListOverflowError";
  constructor() {
    super("too many scheduled workouts in range; narrow the date range");
  }
}

export class ScheduleNotConfiguredError extends Error {
  override readonly name = "ScheduleNotConfiguredError";
  constructor() {
    super("intervals.icu is not configured");
  }
}

export class ActivityNotFoundError extends Error {
  override readonly name = "ActivityNotFoundError";
  constructor() {
    super("activity not found");
  }
}
