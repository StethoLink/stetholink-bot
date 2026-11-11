import { contractResponse, errorResponse, getConsultations, handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { consultationDraftSchema, revisionRequestSchema } from "@/shared/schemas";

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


export async function PATCH(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    const input = revisionRequestSchema.safeParse(await req.json().catch(() => null));
    if (!draftId || draftId.length > 128 || !input.success) return errorResponse("invalid_request", "Invalid revision");
    return contractResponse(consultationDraftSchema, await getConsultations(session).revise(draftId, input.data));
  } catch (err) {
    return handleRouteError(err);
  }
}
