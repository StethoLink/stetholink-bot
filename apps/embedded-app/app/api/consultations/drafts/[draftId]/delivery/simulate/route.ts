import { contractResponse, errorResponse, getConsultations, handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { consultationDeliveryViewSchema } from "@/shared/schemas";

/** Synthetic demo only: the simulated specialist sends its next signed callback. */
export async function POST(_req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    if (!draftId || draftId.length > 128) return errorResponse("invalid_request", "Invalid draft id");
    return contractResponse(consultationDeliveryViewSchema, await getConsultations(session).simulateSpecialist(draftId));
  } catch (error) {
    return handleRouteError(error);
  }
}
