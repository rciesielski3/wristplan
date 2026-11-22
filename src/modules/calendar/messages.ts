// Pure so the client component can import it without pulling server-only modules into the bundle.
export function scheduleErrorMessage(status: number, apiError: string | undefined): string {
  if (status === 503) {
    return "intervals.icu is not configured. Set INTERVALS_API_KEY on the server to publish.";
  }
  return apiError ? `${apiError} (${status})` : `Request failed (${status})`;
}
