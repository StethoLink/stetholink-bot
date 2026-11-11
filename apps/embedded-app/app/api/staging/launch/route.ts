import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getEnv, syntheticStagingEnabled } from "@/platform/tenants/env";
import { requireSameOrigin, saveSession } from "@/platform/auth/session";
import type { IdentityAdapter } from "@/platform/auth/identity";
import { contractResponse, errorResponse, handleRouteError } from "@/apps/embedded-app/server/http/respond";

const inputSchema = z.strictObject({ profile: z.enum(["physician", "same-clinician-other-chart", "other-clinician", "observer"]) });
type Profile = z.infer<typeof inputSchema>["profile"];
const digest = (secret: string) => createHash("sha256").update(secret).digest();

const adapter: IdentityAdapter<Profile> = {
  async verify(profile) {
    const env = getEnv();
    const otherChart = profile === "same-clinician-other-chart";
    const physician = profile !== "observer";
    return {
      source: "synthetic",
      context: {
        clinicianId: profile === "other-clinician" ? "22222222-2222-4222-8222-222222222222" :
          profile === "observer" ? "33333333-3333-4333-8333-333333333333" : "11111111-1111-4111-8111-111111111111",
        tenantId: env.TENANT_ID,
        roles: [physician ? "physician" : "clinician"],
        scopes: physician ? ["chart:read", "consultation:draft", "consultation:approve"] : ["chart:read", "consultation:draft"],
        patientId: otherChart ? "syn-pt-002" : "syn-pt-001",
        encounterId: otherChart ? undefined : "syn-enc-001",
        expiresAt: Date.now() + env.STAGING_SESSION_SECONDS * 1000,
        authorization: "active",
      },
    };
  },
};

export async function POST(request: Request) {
  try {
    const env = getEnv();
    if (!syntheticStagingEnabled(env) || !env.STAGING_LAUNCH_SECRET) return errorResponse("not_found", "Route not found");
    await requireSameOrigin();
    const auth = request.headers.get("authorization") ?? "";
    if (!timingSafeEqual(digest(auth), digest("Bearer " + env.STAGING_LAUNCH_SECRET))) {
      return errorResponse("unauthenticated", "Synthetic launch authorization is required");
    }
    const parsed = inputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return errorResponse("invalid_request", "Select a synthetic launch profile");
    const verified = await adapter.verify(parsed.data.profile);
    await saveSession(verified);
    return contractResponse(z.object({ workspace: z.literal("/embed") }), { workspace: "/embed" });
  } catch (error) {
    return handleRouteError(error);
  }
}
