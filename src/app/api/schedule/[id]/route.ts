import { handleReschedule, handleUnschedule } from "../../../../modules/calendar";
import { scheduleDeps } from "../../../scheduleDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  return handleReschedule(request, (await ctx.params).id, scheduleDeps());
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  return handleUnschedule(request, (await ctx.params).id, scheduleDeps());
}
