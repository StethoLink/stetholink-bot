import { contractResponse, errorResponse, getConsultations, handleRouteError, readJson, requireClinician } from "@/apps/embedded-app/server";
import { approvalRequestSchema, consultationDraftSchema } from "@/shared/schemas";

/** The database records the reviewer and status change in one transaction. */
export async function POST(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  try {
    const session = await requireClinician();
    const { draftId } = await ctx.params;
    const input = approvalRequestSchema.safeParse(await readJson(req));
    if (!input.success || input.data.draftId !== draftId) return errorResponse("invalid_request", "Invalid approval request");
    return contractResponse(consultationDraftSchema, await getConsultations(session).approve(input.data));
  } catch (err) {
    return handleRouteError(err);
  }
}
