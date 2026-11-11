import { contractResponse, errorResponse, getConsultations, handleRouteError, readJson, requireClinician } from "@/apps/embedded-app/server";
import { consultationDraftSchema, transitionRequestSchema } from "@/shared/schemas";

/** Lifecycle bookkeeping only; this route never invokes a real transport or approves. */
export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    const input = transitionRequestSchema.safeParse(await readJson(req));
    if (!draftId || draftId.length > 128 || !input.success) return errorResponse("invalid_request", "Invalid lifecycle command");
    return contractResponse(consultationDraftSchema, await getConsultations(session).transition(draftId, input.data));
  } catch (err) {
    return handleRouteError(err);
  }
}
