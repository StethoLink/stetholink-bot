import { z } from "zod";
import { contractResponse, errorResponse, handleRouteError, readJson, requireClinician } from "@/apps/embedded-app/server";
import { getScribe } from "@/apps/embedded-app/server/scribe";
import { relabelSegmentsRequestSchema, scribeSessionViewSchema } from "@/shared/schemas";

/** Corrects who is speaking in the transcript. The words cannot be changed. */
export async function PATCH(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  try {
    const session = await requireClinician();
    const id = z.uuid().safeParse((await ctx.params).sessionId);
    const input = relabelSegmentsRequestSchema.safeParse(await readJson(req));
    if (!id.success || !input.success) return errorResponse("invalid_request", "Invalid speaker change");
    return contractResponse(scribeSessionViewSchema, await getScribe(session).relabel(id.data, input.data.speakers));
  } catch (error) { return handleRouteError(error); }
}
