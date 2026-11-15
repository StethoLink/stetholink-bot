import { z } from "zod";
import { contractResponse, errorResponse, handleRouteError } from "@/apps/embedded-app/server/http/respond";
import { getSpecialistInbox } from "@/apps/embedded-app/server/specialist";
import { requireSpecialist } from "@/platform/auth/specialist-session";
import { specialistRequestViewSchema } from "@/shared/schemas";

export async function GET(_req: Request, ctx: { params: Promise<{ requestId: string }> }) {
  try {
    const specialist = await requireSpecialist();
    const id = z.uuid().safeParse((await ctx.params).requestId);
    if (!id.success) return errorResponse("invalid_request", "Invalid request id");
    return contractResponse(specialistRequestViewSchema, await getSpecialistInbox(specialist).request(id.data));
  } catch (error) { return handleRouteError(error); }
}
