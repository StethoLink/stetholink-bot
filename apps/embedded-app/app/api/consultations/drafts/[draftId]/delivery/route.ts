import { z } from "zod";
import { contractResponse, errorResponse, getConsultations, handleRouteError, requireClinician } from "@/apps/embedded-app/server";

const deliverySchema = z.object({
  draftId: z.string(), recipientId: z.string(), status: z.enum(["submitted", "responded"]), response: z.string().optional(),
});
const requestSchema = z.object({ recipientId: z.string().trim().min(1).max(128) });

export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const input = requestSchema.safeParse(await req.json().catch(() => null));
    if (!input.success) return errorResponse("invalid_request", "Choose an approved recipient");
    const { draftId } = await ctx.params;
    if (session.source === "smart") return errorResponse("not_implemented", "Durable hospital consultation delivery is not configured");
    return contractResponse(deliverySchema, await getConsultations(session).route(draftId, input.data.recipientId));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    return contractResponse(deliverySchema.nullable(), await getConsultations(session).delivery(draftId));
  } catch (error) {
    return handleRouteError(error);
  }
}
