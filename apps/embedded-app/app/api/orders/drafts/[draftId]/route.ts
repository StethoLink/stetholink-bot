import { contractResponse, errorResponse, handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { getOrders } from "@/apps/embedded-app/server/orders";
import { orderDraftSchema } from "@/shared/schemas";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Row-level security returns only the signed-in clinician's draft on this chart. */
export async function GET(_req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    if (!UUID.test(draftId)) return errorResponse("invalid_request", "Invalid draft id");
    const draft = await getOrders(session).get(draftId);
    return draft ? contractResponse(orderDraftSchema, draft) : errorResponse("not_found", "Draft not found");
  } catch (err) {
    return handleRouteError(err);
  }
}
