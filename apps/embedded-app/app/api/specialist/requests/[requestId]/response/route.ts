import { z } from "zod";
import { contractResponse, errorResponse, handleRouteError, readJson } from "@/apps/embedded-app/server/http/respond";
import { getSpecialistInbox } from "@/apps/embedded-app/server/specialist";
import { requireSpecialist } from "@/platform/auth/specialist-session";
import { allowRequest } from "@/platform/http/rate-limit";
import { specialistRequestViewSchema, specialistResponseRequestSchema } from "@/shared/schemas";

/** The specialist accepts, declines with a reason, or reports. Recorded through the provider callback contract. */
export async function POST(req: Request, ctx: { params: Promise<{ requestId: string }> }) {
  try {
    const specialist = await requireSpecialist();
    const id = z.uuid().safeParse((await ctx.params).requestId);
    const input = specialistResponseRequestSchema.safeParse(await readJson(req));
    if (!id.success || !input.success) return errorResponse("invalid_request", "The reply could not be read. A decline needs a reason; a report needs a summary");
    if (!allowRequest(`specialist-reply:${specialist.specialistId}`, 60, 60_000)) return errorResponse("conflict", "Too many replies in a short time. Wait a minute and try again");
    const { idempotencyKey, ...reply } = input.data;
    return contractResponse(specialistRequestViewSchema, await getSpecialistInbox(specialist).respond(id.data, reply, idempotencyKey));
  } catch (error) { return handleRouteError(error); }
}
