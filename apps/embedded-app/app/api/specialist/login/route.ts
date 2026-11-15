import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { errorResponse, handleRouteError, readJson } from "@/apps/embedded-app/server/http/respond";
import { consoleEmailSender, requestSpecialistCode } from "@/platform/auth/specialist-session";
import { requireSameOrigin } from "@/platform/auth/session";
import { allowRequest } from "@/platform/http/rate-limit";
import { getEnv } from "@/platform/tenants/env";
import { specialistCodeRequestSchema } from "@/shared/schemas";

/**
 * Asks for a one-time sign-in code by email. The answer never says whether the address is
 * registered. The email holds the code and a link, and nothing about any patient.
 */
export async function POST(req: Request) {
  try {
    await requireSameOrigin();
    const env = getEnv();
    if (env.EMAIL_PROVIDER === "none") return errorResponse("not_implemented", "Sign-in by email is not set up. Open the inbox from your EHR");
    const input = specialistCodeRequestSchema.safeParse(await readJson(req));
    if (!input.success) return errorResponse("invalid_request", "Enter your email address");
    const h = await headers();
    const address = h.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const email = createHash("sha256").update(input.data.email.toLowerCase()).digest("hex").slice(0, 16);
    if (allowRequest(`specialist-code:${address}`, 10, 15 * 60_000) && allowRequest(`specialist-code-for:${email}`, 3, 15 * 60_000)) {
      const origin = `${env.NODE_ENV === "production" ? "https" : "http"}://${h.get("host")}`;
      await requestSpecialistCode(input.data.email, origin, env.EMAIL_PROVIDER === "console" ? consoleEmailSender : undefined);
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleRouteError(error); }
}
