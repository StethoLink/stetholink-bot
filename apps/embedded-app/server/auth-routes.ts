import "server-only";
import { z } from "zod";
import { clearSession, requireClinician, requireSameOrigin } from "@/platform/auth/session";
import { contractResponse, handleRouteError } from "./http/respond";

const sessionSchema = z.object({
  clinicianId: z.uuid(), tenantId: z.string(), roles: z.array(z.enum(["clinician", "physician"])),
  patientId: z.string(), encounterId: z.string().optional(), expiresAt: z.number().int(),
});

export async function logout() {
  try {
    await requireSameOrigin();
    await clearSession();
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function session() {
  try {
    return contractResponse(sessionSchema, (await requireClinician()).context);
  } catch (error) {
    return handleRouteError(error);
  }
}
