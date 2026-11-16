import { z } from "zod";
import { contractResponse, handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { getOrders } from "@/apps/embedded-app/server/orders";
import { chartWriteResultSchema } from "@/shared/schemas";

type Context = { params: Promise<{ draftId: string }> };

/** The approved orders of this draft, what of them is in the chart, and the text to enter for the rest. Reads only. */
export async function GET(_req: Request, ctx: Context) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    return contractResponse(z.array(chartWriteResultSchema), await getOrders(session).chart(draftId));
  } catch (error) { return handleRouteError(error); }
}

/** The physician creates each approved order in the EHR, once each. Pending and rejected orders are never written. */
export async function POST(_req: Request, ctx: Context) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    return contractResponse(z.array(chartWriteResultSchema), await getOrders(session).writeToChart(draftId));
  } catch (error) { return handleRouteError(error); }
}
