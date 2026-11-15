import { z } from "zod";
import { contractResponse, errorResponse, handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { getScribe } from "@/apps/embedded-app/server/scribe";
import { scribeSessionViewSchema } from "@/shared/schemas";

type Context = { params: Promise<{ sessionId: string }> };
export async function GET(_req: Request, ctx: Context) {
  try {
    const session = await requireClinician();
    const id = z.uuid().safeParse((await ctx.params).sessionId);
    if (!id.success) return errorResponse("invalid_request", "Invalid visit id");
    return contractResponse(scribeSessionViewSchema, await getScribe(session).get(id.data));
  } catch (error) { return handleRouteError(error); }
}
/** Discards a visit that was not approved. Its transcript and note are deleted at once. */
export async function DELETE(_req: Request, ctx: Context) {
  try {
    const session = await requireClinician();
    const id = z.uuid().safeParse((await ctx.params).sessionId);
    if (!id.success) return errorResponse("invalid_request", "Invalid visit id");
    await getScribe(session).discard(id.data);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleRouteError(error); }
}
