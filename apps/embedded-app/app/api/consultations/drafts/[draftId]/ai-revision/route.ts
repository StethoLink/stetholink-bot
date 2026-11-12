import { contractResponse, errorResponse, getConsultations, handleRouteError, readJson, requireClinician } from "@/apps/embedded-app/server";
import { consultationDraftSchema, modelRevisionRequestSchema } from "@/shared/schemas";

/**
 * Asks the model to reword the draft from the physician's instruction. Documented facts and
 * their sources cannot change, and the result returns to physician review; it is never approved here.
 */
export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    const input = modelRevisionRequestSchema.safeParse(await readJson(req));
    if (!draftId || draftId.length > 128 || !input.success) return errorResponse("invalid_request", "Describe the change you want in a sentence");
    return contractResponse(consultationDraftSchema, await getConsultations(session).reviseWithModel(draftId, input.data));
  } catch (err) {
    return handleRouteError(err);
  }
}
