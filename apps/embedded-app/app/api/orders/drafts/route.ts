import { contractResponse, errorResponse, handleRouteError, readJson, requireClinician } from "@/apps/embedded-app/server";
import { getOrders } from "@/apps/embedded-app/server/orders";
import { createOrderDraftRequestSchema, orderDraftListSchema, orderDraftSchema, orderNoMatchSchema } from "@/shared/schemas";

/** The model call may take up to OPENAI_TIMEOUT_MS (at most 120 s); the platform must not end the request first. */
export const maxDuration = 120;

/**
 * Draft orders from the physician's own words, chosen only from the hospital's order catalog. A stored draft (201), or the answer
 * that nothing could be drafted (200, nothing stored). Every line starts pending: nothing is approved, signed or sent here.
 */
export async function POST(req: Request) {
  try {
    const session = await requireClinician();
    const input = createOrderDraftRequestSchema.safeParse(await readJson(req));
    if (!input.success) return errorResponse("invalid_request", "Describe the orders you want prepared");
    const result = await getOrders(session).create(input.data);
    return "outcome" in result ? contractResponse(orderNoMatchSchema, result, 200) : contractResponse(orderDraftSchema, result, 201);
  } catch (err) {
    return handleRouteError(err);
  }
}

/** The order drafts of this visit, newest first. */
export async function GET() {
  try {
    const session = await requireClinician();
    return contractResponse(orderDraftListSchema, await getOrders(session).list());
  } catch (err) {
    return handleRouteError(err);
  }
}
