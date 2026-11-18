import { handleDuplicate } from "../../../../../modules/workouts";
import { workoutDeps } from "../../../../workoutDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleDuplicate(request, (await ctx.params).id, workoutDeps());
}
