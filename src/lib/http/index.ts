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

export const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

export async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json")
    throw new HttpError(415, "content-type must be application/json");
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "body too large");
      }
      chunks.push(value);
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

export async function guarded(
  request: Request,
  allowedHosts: string | undefined,
  mutates: boolean,
  run: () => Promise<Response>,
  toResponse: (err: unknown) => Response,
): Promise<Response> {
  const blocked = mutates
    ? rejectCrossOrigin(request, allowedHosts)
    : rejectForeignHost(request, allowedHosts);
  if (blocked) return blocked;
  try {
    return await run();
  } catch (err) {
    return toResponse(err);
  }
}
