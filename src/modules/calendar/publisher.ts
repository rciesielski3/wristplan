import type { TargetType } from "../workouts";

export interface PublishInput {
  readonly externalId: string;
  readonly date: string;
  readonly name: string;
  readonly text: string;
  readonly sport: "run";
  readonly target: TargetType;
}

// publish MUST be idempotent per externalId: repeating it returns the same remoteId and never
// creates a second remote event. The service relies on this to recover from crashes and lost responses.
export interface WorkoutPublisher {
  publish(input: PublishInput): Promise<{ remoteId: string }>;
  reschedule(remoteId: string, date: string): Promise<void>;
  remove(remoteId: string): Promise<void>;
}

// Messages are fixed strings: adapters must never copy transport detail into them.
export class PublisherError extends Error {
  override readonly name: string = "PublisherError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class PublisherNotFoundError extends PublisherError {
  override readonly name = "PublisherNotFoundError";
  constructor() {
    super("remote workout not found", 404);
  }
}

export class PublisherForeignEventError extends PublisherError {
  override readonly name = "PublisherForeignEventError";
  constructor() {
    super("remote workout was not created by wristplan");
  }
}

export class PublisherAuthError extends PublisherError {
  override readonly name = "PublisherAuthError";
  constructor(status?: number) {
    super("publisher rejected the credentials", status);
  }
}

export class PublisherRateLimitError extends PublisherError {
  override readonly name = "PublisherRateLimitError";
  constructor() {
    super("publisher rate limit hit", 429);
  }
}

export class PublisherTransientError extends PublisherError {
  override readonly name = "PublisherTransientError";
  constructor(status?: number) {
    super("publisher is temporarily unavailable", status);
  }
}

export class PublisherRejectedError extends PublisherError {
  override readonly name = "PublisherRejectedError";
  constructor(status?: number) {
    super("publisher rejected the request", status);
  }
}
