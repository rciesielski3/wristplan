import { getDb } from "../../../../../lib/db";
import { getEnv } from "../../../../../lib/env";
import { handleFitDownload } from "../../../../../modules/activities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  return handleFitDownload(request, id, getDb(), getEnv().ALLOWED_HOSTS);
}
