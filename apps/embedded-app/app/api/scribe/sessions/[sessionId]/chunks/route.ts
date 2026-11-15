import { z } from "zod";
import { contractResponse, errorResponse, handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { getScribe } from "@/apps/embedded-app/server/scribe";
import { MAX_CHUNK_BYTES, MAX_CHUNK_SECONDS } from "@/core/scribe/service";

export const maxDuration = 60;
const query = z.object({ index: z.coerce.number().int().min(0).max(999), durationMs: z.coerce.number().int().min(200).max(MAX_CHUNK_SECONDS * 1000) });
const result = z.object({ index: z.number().int(), added: z.boolean(), sentences: z.number().int() });

/**
 * One part of the recording, as the raw audio body. It is read into memory, sent to the
 * transcription provider by the server and dropped: it is never written to disk or to the database,
 * and the provider key never reaches the browser.
 */
export async function POST(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  try {
    const session = await requireClinician();
    const id = z.uuid().safeParse((await ctx.params).sessionId);
    const params = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    const mimeType = req.headers.get("content-type") ?? "";
    if (!id.success || !params.success || !/^audio\//i.test(mimeType)) return errorResponse("invalid_request", "This part of the recording could not be accepted");
    if (Number(req.headers.get("content-length") ?? 0) > MAX_CHUNK_BYTES) return errorResponse("invalid_request", "This part of the recording is too large");
    const audio = new Uint8Array(await req.arrayBuffer());
    if (audio.byteLength > MAX_CHUNK_BYTES) return errorResponse("invalid_request", "This part of the recording is too large");
    const outcome = await getScribe(session).addChunk(id.data, { ...params.data, mimeType, audio });
    return contractResponse(result, { index: outcome.index, added: outcome.added, sentences: outcome.sentences });
  } catch (error) { return handleRouteError(error); }
}
