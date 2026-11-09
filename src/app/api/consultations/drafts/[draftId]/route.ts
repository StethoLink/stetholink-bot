import { contractResponse, errorResponse, getConsultations, handleRouteError, requireClinician } from "@/server";
import { consultationDraftSchema } from "@/shared/schemas";

/** RLS returns only the signed-in clinician's draft. */
export async function GET(_req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    if (!draftId || draftId.length > 128) return errorResponse("invalid_request", "Invalid draft id");
    const draft = await getConsultations(session).get(draftId);
    return draft ? contractResponse(consultationDraftSchema, draft) : errorResponse("not_found", "Draft not found");
  } catch (err) {
    return handleRouteError(err);
  }
}
