export class IntervalsConfigError extends Error {
  override readonly name = "IntervalsConfigError";
  constructor(readonly variable: string) {
    super(`Missing required environment variable ${variable}`);
  }
}

export class IntervalsValidationError extends Error {
  override readonly name = "IntervalsValidationError";
}

export class IntervalsApiError extends Error {
  override readonly name: string = "IntervalsApiError";
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    detail: string,
  ) {
    super(`intervals.icu ${method} ${path} failed with ${status}${detail ? `: ${detail}` : ""}`);
  }
}

export class IntervalsNotFoundError extends IntervalsApiError {
  override readonly name = "IntervalsNotFoundError";
  constructor(method: string, path: string, detail: string) {
    super(404, method, path, detail);
  }
}

export class IntervalsResponseError extends Error {
  override readonly name = "IntervalsResponseError";
  constructor(
    readonly method: string,
    readonly path: string,
    reason: string,
  ) {
    super(`intervals.icu ${method} ${path} returned unexpected response: ${reason}`);
  }
}
