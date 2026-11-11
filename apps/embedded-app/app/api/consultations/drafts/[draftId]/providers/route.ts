import { contractResponse, errorResponse, getConsultations, handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { eligibleProvidersSchema } from "@/shared/schemas";

/** Providers this tenant may use that offer the consultation's requested specialty. */
export async function GET(_req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    if (!draftId || draftId.length > 128) return errorResponse("invalid_request", "Invalid draft id");
    return contractResponse(eligibleProvidersSchema, await getConsultations(session).providers(draftId));
  } catch (error) {
    return handleRouteError(error);
  }
}
