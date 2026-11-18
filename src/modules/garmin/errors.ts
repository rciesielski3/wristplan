export class GarminConfigError extends Error {
  override readonly name = "GarminConfigError";
  constructor(readonly variable: string) {
    super(`Missing required environment variable ${variable}`);
  }
}

export class GarminValidationError extends Error {
  override readonly name = "GarminValidationError";
}

export class GarminApiError extends Error {
  override readonly name: string = "GarminApiError";
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    detail: string,
  ) {
    super(`garmin ${method} ${path} failed with ${status}${detail ? `: ${detail}` : ""}`);
  }
}

export class GarminAuthError extends GarminApiError {
  override readonly name = "GarminAuthError";
}

export class GarminRateLimitError extends GarminApiError {
  override readonly name = "GarminRateLimitError";
  constructor(
    method: string,
    path: string,
    detail: string,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(429, method, path, detail);
  }
}

export class GarminServerError extends GarminApiError {
  override readonly name = "GarminServerError";
}

export class GarminNetworkError extends Error {
  override readonly name = "GarminNetworkError";
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timedOut: boolean,
  ) {
    super(`garmin ${method} ${path} failed: ${timedOut ? "timeout" : "network error"}`);
  }
}

export class GarminResponseError extends Error {
  override readonly name = "GarminResponseError";
  constructor(
    readonly method: string,
    readonly path: string,
    reason: string,
  ) {
    super(`garmin ${method} ${path} returned unexpected response: ${reason}`);
  }
}
