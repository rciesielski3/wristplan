import { handleDelete, handleGet, handleUpdate } from "../../../../modules/workouts";
import { workoutDeps } from "../../../workoutDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handleGet(request, (await ctx.params).id, workoutDeps());
}

export async function PUT(request: Request, ctx: Ctx): Promise<Response> {
  return handleUpdate(request, (await ctx.params).id, workoutDeps());
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  return handleDelete(request, (await ctx.params).id, workoutDeps());
}
