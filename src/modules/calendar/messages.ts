// Pure so the client component can import it without pulling server-only modules into the bundle.
export function scheduleErrorMessage(status: number, apiError: string | undefined): string {
  if (status === 503) {
    return "intervals.icu is not configured. Set INTERVALS_API_KEY on the server to publish.";
  }
  return apiError ? `${apiError} (${status})` : `Request failed (${status})`;
}

export function linkErrorMessage(status: number, apiError: string | undefined): string {
  if (status === 404) return "Activity or plan not found. Reload the page and try again.";
  if (status === 409) return "That activity is already linked to another plan.";
  if (status === 503) return "Server unavailable (503). Try again later.";
  return scheduleErrorMessage(status, apiError);
}
