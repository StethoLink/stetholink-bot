import "server-only";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { getEnv, syntheticStagingEnabled } from "@/platform/tenants/env";
import type { VerifiedLaunch } from "./identity";
import { launchCookie, readHandle, sessionCookie, storeHandle } from "./session-store";

export class AuthError extends Error {
  constructor(readonly code: "unauthenticated" | "forbidden", message: string) {
    super(message);
  }
}

const launchSchema = z.object({
  context: z.object({
    clinicianId: z.uuid(),
    tenantId: z.string().min(1),
    roles: z.array(z.enum(["clinician", "physician"])).min(1),
    scopes: z.array(z.string()),
    patientId: z.string().min(1),
    encounterId: z.string().min(1).optional(),
    expiresAt: z.number().int(),
    authorization: z.literal("active"),
  }),
  source: z.enum(["smart", "synthetic"]),
  ehrAccessToken: z.string().min(1).optional(),
});

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: getEnv().NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge };
}

export async function saveSession(launch: VerifiedLaunch) {
  const jar = await cookies();
  await readHandle(jar.get(sessionCookie)?.value, "session", true);
  const expiresAt = launch.context.expiresAt;
  const handle = await storeHandle("session", launch, expiresAt);
  jar.set(sessionCookie, handle, cookieOptions(Math.floor((expiresAt - Date.now()) / 1000)));
}

export async function clearSession() {
  const jar = await cookies();
  await readHandle(jar.get(sessionCookie)?.value, "session", true);
  await readHandle(jar.get(launchCookie)?.value, "launch", true);
  jar.set(sessionCookie, "", cookieOptions(0));
  jar.set(launchCookie, "", cookieOptions(0));
}

export async function requireSameOrigin() {
  const h = await headers();
  const origin = h.get("origin");
  const host = h.get("host");
  const expected = host && `${getEnv().NODE_ENV === "production" ? "https" : "http"}://${host}`;
  if (["cross-site", "same-site"].includes(h.get("sec-fetch-site") ?? "") || (origin && origin !== expected)) {
    throw new AuthError("forbidden", "Cross-origin request denied");
  }
}

export function localSyntheticEnabled() {
  const env = getEnv();
  return env.NODE_ENV !== "production" && !env.VERCEL_ENV && !env.VERCEL_TARGET_ENV &&
    env.AUTH_MODE === "dev" && env.CLINICAL_DATA_SOURCE === "synthetic";
}

export async function requireClinician(options: { navigation?: boolean } = {}): Promise<VerifiedLaunch> {
  if (!options.navigation) await requireSameOrigin();
  const env = getEnv();
  const jar = await cookies();
  const active = syntheticStagingEnabled(env) || (env.AUTH_MODE === "smart" && env.CLINICAL_DATA_SOURCE !== "synthetic");
  const raw = active ? await readHandle(jar.get(sessionCookie)?.value, "session") : undefined;
  const verified = launchSchema.safeParse(raw);
  if (verified.success && verified.data.context.expiresAt > Date.now() &&
      verified.data.context.tenantId === env.TENANT_ID &&
      (verified.data.source === "synthetic" ? syntheticStagingEnabled(env) :
        env.AUTH_MODE === "smart" && env.CLINICAL_DATA_SOURCE !== "synthetic" && !!verified.data.ehrAccessToken)) {
    return verified.data;
  }
  if (localSyntheticEnabled()) {
    const ahmed = env.LOCAL_SYNTHETIC_CHART === "ahmed";
    return {
      source: "synthetic",
      context: {
        clinicianId: "11111111-1111-4111-8111-111111111111", tenantId: env.TENANT_ID,
        roles: ["physician"], scopes: ["chart:read", "consultation:draft", "consultation:approve"],
        patientId: ahmed ? "syn-pt-ahmed" : "syn-pt-001", encounterId: ahmed ? "syn-enc-ahmed" : "syn-enc-001",
        expiresAt: Date.now() + 60_000, authorization: "active",
      },
    };
  }
  throw new AuthError("unauthenticated", "Open StethoLink from the active EHR chart");
}
