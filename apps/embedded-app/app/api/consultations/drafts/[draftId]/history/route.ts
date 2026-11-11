import { z } from "zod";
import { contractResponse, errorResponse, getConsultations, handleRouteError, requireClinician } from "@/apps/embedded-app/server";
import { consultationHistorySchema } from "@/shared/schemas";

export async function GET(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    const cursor = z.coerce.number().int().positive().max(2147483647).safeParse(new URL(req.url).searchParams.get("beforeVersion") ?? 2147483647);
    if (!draftId || draftId.length > 128 || !cursor.success) return errorResponse("invalid_request", "Invalid history request");
    return contractResponse(consultationHistorySchema, await getConsultations(session).history(draftId, cursor.data));
  } catch (err) {
    return handleRouteError(err);
  }
}
