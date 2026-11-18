import { handleText } from "../../../../../modules/workouts";
import { workoutDeps } from "../../../../workoutDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleText(request, (await ctx.params).id, workoutDeps());
}
