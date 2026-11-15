import { z } from "zod";
import { contractResponse, errorResponse, getConsultations, handleRouteError, readJson, requireClinician } from "@/apps/embedded-app/server";
import { chartWriteResultSchema } from "@/shared/schemas";

const input = z.object({ items: z.array(z.enum(["consultation", "report"])).min(1).max(2) }).strict();
type Context = { params: Promise<{ draftId: string }> };

/** What of this consultation is in the chart, and the text to copy for what is not. */
export async function GET(_req: Request, ctx: Context) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    if (!draftId || draftId.length > 128) return errorResponse("invalid_request", "Invalid draft id");
    return contractResponse(z.array(chartWriteResultSchema), await getConsultations(session).chart(draftId));
  } catch (error) { return handleRouteError(error); }
}
/** The physician writes the approved consultation, the specialist's reply, or both, to the chart. Create only, once each. */
export async function POST(req: Request, ctx: Context) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    const body = input.safeParse(await readJson(req));
    if (!draftId || draftId.length > 128 || !body.success) return errorResponse("invalid_request", "Choose what to write to the chart");
    return contractResponse(z.array(chartWriteResultSchema), await getConsultations(session).chart(draftId, body.data.items));
  } catch (error) { return handleRouteError(error); }
}
