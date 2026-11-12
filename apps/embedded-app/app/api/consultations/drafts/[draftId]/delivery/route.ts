import { contractResponse, errorResponse, getConsultations, handleRouteError, readJson, requireClinician } from "@/apps/embedded-app/server";
import { consultationDeliveryViewSchema, dispatchRequestSchema } from "@/shared/schemas";

/** Sends the stored, physician-approved consultation to its approved provider. Repeating the command never sends twice. */
export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    const input = dispatchRequestSchema.safeParse(await readJson(req));
    if (!draftId || draftId.length > 128 || !input.success) return errorResponse("invalid_request", "Invalid delivery request");
    if (session.source === "smart") return errorResponse("not_implemented", "Durable hospital consultation delivery is not configured");
    return contractResponse(consultationDeliveryViewSchema, await getConsultations(session).route(draftId, input.data));
  } catch (error) {
    return handleRouteError(error);
  }
}

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
