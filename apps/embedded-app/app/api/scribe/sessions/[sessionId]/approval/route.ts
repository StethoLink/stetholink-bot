import { z } from "zod";
import { contractResponse, errorResponse, handleRouteError, readJson, requireClinician } from "@/apps/embedded-app/server";
import { getScribe } from "@/apps/embedded-app/server/scribe";
import { approveScribeRequestSchema, scribeSessionViewSchema } from "@/shared/schemas";

export const maxDuration = 120;
/**
 * The physician approves this version of the note and names each item for the chart. Each one is
 * then created in the EHR at most once. Repeating the request resumes; it never writes twice.
 */
export async function POST(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  try {
    const session = await requireClinician();
    const id = z.uuid().safeParse((await ctx.params).sessionId);
    const input = approveScribeRequestSchema.safeParse(await readJson(req));
    if (!id.success || !input.success) return errorResponse("invalid_request", "Invalid approval");
    return contractResponse(scribeSessionViewSchema, await getScribe(session).approveAndWrite(id.data, input.data));
  } catch (error) { return handleRouteError(error); }
}
