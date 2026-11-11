import { contractResponse, errorResponse, getConsultations, handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { consultationDeliveryViewSchema, dispatchRequestSchema } from "@/shared/schemas";

/** Sends the stored, physician-approved consultation to an allowed provider. Repeating the command never sends twice. */
export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const input = dispatchRequestSchema.safeParse(await req.json().catch(() => null));
    const { draftId } = await ctx.params;
    if (!draftId || draftId.length > 128 || !input.success) return errorResponse("invalid_request", "Choose an approved recipient");
    return contractResponse(consultationDeliveryViewSchema, await getConsultations(session).route(draftId, input.data));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Delivery state, attempts and the specialist's reply for the clinician's own chart. */
export async function GET(_req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    if (!draftId || draftId.length > 128) return errorResponse("invalid_request", "Invalid draft id");
    return contractResponse(consultationDeliveryViewSchema.nullable(), await getConsultations(session).delivery(draftId));
  } catch (error) {
    return handleRouteError(error);
  }
}
