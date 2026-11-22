import { handleRetry } from "../../../../../modules/calendar";
import { scheduleDeps } from "../../../../scheduleDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRetry(request, (await ctx.params).id, scheduleDeps());
}
