const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function hostname(host: string): string {
  const end = host.startsWith("[") ? host.indexOf("]") + 1 : host.indexOf(":");
  return (end > 0 ? host.slice(0, end) : host).toLowerCase();
}

// Defence against DNS rebinding: a rebound page carries a matching Origin but an attacker Host.
export function isHostAllowed(host: string | null, extra?: string): boolean {
  if (host === null) return false;
  const allowed = [
    ...LOOPBACK_HOSTS,
    ...(extra ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  ];
  return allowed.includes(hostname(host));
}

export function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function rejectForeignHost(request: Request, extraHosts?: string): Response | null {
  return isHostAllowed(request.headers.get("host"), extraHosts)
    ? null
    : json({ error: "forbidden" }, 403);
}

// Browsers always send Origin on cross-origin POST, so only non-browser clients (curl) omit it;
// they cannot be driven by a web page, which is the CSRF threat for a local single-user app.
export function rejectCrossOrigin(request: Request, extraHosts?: string): Response | null {
  const foreign = rejectForeignHost(request, extraHosts);
  if (foreign) return foreign;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return json({ error: "forbidden" }, 403);
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {}
  if (originHost === null || originHost !== request.headers.get("host")) {
    return json({ error: "forbidden" }, 403);
  }
  return null;
}
