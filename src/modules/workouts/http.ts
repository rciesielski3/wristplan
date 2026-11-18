import { json, rejectCrossOrigin, rejectForeignHost } from "../../lib/http";
import {
  WorkoutCorruptError,
  WorkoutNotFoundError,
  WorkoutNotTemplateError,
  type WorkoutRepository,
} from "./repository";
import { toIntervalsText } from "./text";
import { WorkoutValidationError } from "./validate";

export const MAX_BODY_BYTES = 64 * 1024;
// A 4 KiB body of invalid repeats yields ~1500 issues (~150 KB); cap the echo.
export const MAX_ISSUES = 20;
const MAX_ISSUE_TEXT = 300;

export interface WorkoutRouteDeps {
  readonly repo: () => WorkoutRepository;
  readonly allowedHosts?: string | undefined;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

const serialize = (s: Awaited<ReturnType<WorkoutRepository["get"]>>) => ({
  id: s.id,
  isTemplate: s.isTemplate,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
  workout: s.workout,
});

async function readJson(request: Request): Promise<unknown> {
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

function toResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.publicMessage }, err.status);
  if (err instanceof WorkoutValidationError) {
    return json(
      {
        error: "invalid workout",
        issues: err.issues.slice(0, MAX_ISSUES).map((i) => ({
          path: i.path.slice(0, MAX_ISSUE_TEXT),
          message: i.message.slice(0, MAX_ISSUE_TEXT),
        })),
      },
      422,
    );
  }
  if (err instanceof WorkoutNotFoundError) return json({ error: "not found" }, 404);
  if (err instanceof WorkoutNotTemplateError)
    return json({ error: "workout is not a template" }, 409);
  if (err instanceof WorkoutCorruptError) return json({ error: "stored workout is corrupt" }, 409);
  console.error(`workout request failed: ${err instanceof Error ? err.name : "UnknownError"}`);
  return json({ error: "internal error" }, 500);
}

async function guarded(
  request: Request,
  deps: WorkoutRouteDeps,
  mutates: boolean,
  run: () => Promise<Response>,
): Promise<Response> {
  const blocked = mutates
    ? rejectCrossOrigin(request, deps.allowedHosts)
    : rejectForeignHost(request, deps.allowedHosts);
  if (blocked) return blocked;
  try {
    return await run();
  } catch (err) {
    return toResponse(err);
  }
}

export function handleList(request: Request, deps: WorkoutRouteDeps): Promise<Response> {
  return guarded(request, deps, false, async () => {
    const flag = new URL(request.url).searchParams.get("templates");
    const templates = flag === "true" ? true : flag === "false" ? false : undefined;
    const { items, corruptIds } = await deps
      .repo()
      .list(templates === undefined ? {} : { templates });
    return json({ items: items.map(serialize), corruptIds }, 200);
  });
}

export function handleCreate(request: Request, deps: WorkoutRouteDeps): Promise<Response> {
  return guarded(request, deps, true, async () =>
    json(serialize(await deps.repo().create(await readJson(request))), 201),
  );
}

export function handleGet(request: Request, id: string, deps: WorkoutRouteDeps): Promise<Response> {
  return guarded(request, deps, false, async () => json(serialize(await deps.repo().get(id)), 200));
}

export function handleUpdate(
  request: Request,
  id: string,
  deps: WorkoutRouteDeps,
): Promise<Response> {
  return guarded(request, deps, true, async () =>
    json(serialize(await deps.repo().update(id, await readJson(request))), 200),
  );
}

export function handleDelete(
  request: Request,
  id: string,
  deps: WorkoutRouteDeps,
): Promise<Response> {
  return guarded(request, deps, true, async () => {
    await deps.repo().delete(id);
    return json({ ok: true }, 200);
  });
}

export function handleDuplicate(
  request: Request,
  id: string,
  deps: WorkoutRouteDeps,
): Promise<Response> {
  return guarded(request, deps, true, async () => {
    const asTemplate = new URL(request.url).searchParams.get("asTemplate") === "true";
    return json(serialize(await deps.repo().duplicate(id, { asTemplate })), 201);
  });
}

export function handleUseTemplate(
  request: Request,
  id: string,
  deps: WorkoutRouteDeps,
): Promise<Response> {
  return guarded(request, deps, true, async () =>
    json(serialize(await deps.repo().createFromTemplate(id)), 201),
  );
}

export function handleText(
  request: Request,
  id: string,
  deps: WorkoutRouteDeps,
): Promise<Response> {
  return guarded(request, deps, false, async () => {
    const { workout } = await deps.repo().get(id);
    return new Response(toIntervalsText(workout), {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
