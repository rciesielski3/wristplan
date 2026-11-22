import { handleLink, handleUnlink } from "../../../../../modules/calendar";
import { scheduleDeps } from "../../../../scheduleDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx): Promise<Response> {
  return handleLink(request, (await ctx.params).id, scheduleDeps());
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  return handleUnlink(request, (await ctx.params).id, scheduleDeps());
}
