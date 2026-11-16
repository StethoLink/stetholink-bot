import { contractResponse, errorResponse, handleRouteError, readJson, requireClinician } from "@/apps/embedded-app/server";
import { getOrders } from "@/apps/embedded-app/server/orders";
import { orderDecisionRequestSchema, orderDraftSchema } from "@/shared/schemas";

/**
 * The physician approves or rejects lines of a draft, in one command. Only a mapped physician can; the database enforces the role,
 * the version, a line decided once, and the acknowledgement of an allergy or a major interaction again. Nothing is written to the EHR here.
 */
export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    const input = orderDecisionRequestSchema.safeParse(await readJson(req));
    if (!input.success || input.data.draftId !== draftId) return errorResponse("invalid_request", "Invalid order decision");
    return contractResponse(orderDraftSchema, await getOrders(session).decide(input.data));
  } catch (err) {
    return handleRouteError(err);
  }
}
