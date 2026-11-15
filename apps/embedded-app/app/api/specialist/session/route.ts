import { headers } from "next/headers";
import { contractResponse, errorResponse, handleRouteError, readJson } from "@/apps/embedded-app/server/http/respond";
import { getSpecialistInbox } from "@/apps/embedded-app/server/specialist";
import { redeemSpecialistCode, requireSpecialist } from "@/platform/auth/specialist-session";
import { requireSameOrigin } from "@/platform/auth/session";
import { allowRequest } from "@/platform/http/rate-limit";
import { specialistCodeRedeemSchema, specialistIdentitySchema } from "@/shared/schemas";

export async function GET() {
  try {
    return contractResponse(specialistIdentitySchema, getSpecialistInbox(await requireSpecialist()).identity());
  } catch (error) { return handleRouteError(error); }
}
/** Exchanges a one-time email code for an inbox session. */
export async function POST(req: Request) {
  try {
    await requireSameOrigin();
    const input = specialistCodeRedeemSchema.safeParse(await readJson(req));
    if (!input.success) return errorResponse("invalid_request", "Enter your email address and the code you received");
    const address = (await headers()).get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    if (!allowRequest(`specialist-redeem:${address}`, 10, 15 * 60_000)) return errorResponse("unauthenticated", "Too many attempts. Wait 15 minutes and ask for a new code");
    await redeemSpecialistCode(input.data.email, input.data.code);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleRouteError(error); }
}
