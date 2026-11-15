import { z } from "zod";
import { contractResponse, errorResponse, handleRouteError, readJson, requireClinician } from "@/apps/embedded-app/server";
import { getScribe } from "@/apps/embedded-app/server/scribe";
import { editScribeNoteRequestSchema, scribeSessionViewSchema } from "@/shared/schemas";

/** The model call may take up to OPENAI_TIMEOUT_MS; the platform must not end the request first. */
export const maxDuration = 120;
type Context = { params: Promise<{ sessionId: string }> };

/** Ends the recording and writes the note from the transcript. The note awaits the physician; nothing is approved or written here. */
export async function POST(_req: Request, ctx: Context) {
  try {
    const session = await requireClinician();
    const id = z.uuid().safeParse((await ctx.params).sessionId);
    if (!id.success) return errorResponse("invalid_request", "Invalid visit id");
    return contractResponse(scribeSessionViewSchema, await getScribe(session).generateNote(id.data));
  } catch (error) { return handleRouteError(error); }
}
/** The clinician's own edits to the note. */
export async function PATCH(req: Request, ctx: Context) {
  try {
    const session = await requireClinician();
    const id = z.uuid().safeParse((await ctx.params).sessionId);
    const input = editScribeNoteRequestSchema.safeParse(await readJson(req));
    if (!id.success || !input.success) return errorResponse("invalid_request", "The edited note could not be read");
    return contractResponse(scribeSessionViewSchema, await getScribe(session).editNote(id.data, input.data));
  } catch (error) { return handleRouteError(error); }
}
