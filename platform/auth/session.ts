import "server-only";
import { getEnv } from "@/platform/tenants/env";
import { cookies, headers } from "next/headers";
import { authUserSchema, clinicianRole, createSupabaseTransport, SupabaseError, tokenSchema } from "./supabase";

export interface ClinicianSession {
  clinicianId: string;
  roles: ReadonlyArray<"clinician" | "admin">;
  accessToken?: string;
}

export class AuthError extends Error {
  constructor(readonly code: "unauthenticated" | "forbidden", message: string) {
    super(message);
  }
}

export const ACCESS_COOKIE = "stetholink-access";
export const REFRESH_COOKIE = "stetholink-refresh";

export async function saveSession(tokens: { access_token: string; refresh_token: string; expires_in: number }) {
  const jar = await cookies();
  const options = { httpOnly: true, secure: getEnv().NODE_ENV === "production", sameSite: "lax" as const, path: "/" };
  jar.set(ACCESS_COOKIE, tokens.access_token, { ...options, maxAge: tokens.expires_in });
  jar.set(REFRESH_COOKIE, tokens.refresh_token, { ...options, maxAge: 60 * 60 * 24 * 30 });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

/** Cookie mutations must come from this origin. Bearer-only API clients are exempt. */
export async function requireSameOrigin() {
  const h = await headers();
  if (["cross-site", "same-site"].includes(h.get("sec-fetch-site") ?? "")) throw new AuthError("forbidden", "Cross-origin request denied");
  const origin = h.get("origin");
  const host = h.get("host");
  if (origin && (!host || new URL(origin).host !== host)) throw new AuthError("forbidden", "Cross-origin request denied");
}

/** Validate the token with Supabase Auth, never with unverified JWT contents. */
export async function verifyClinician(token: string, request = createSupabaseTransport()): Promise<ClinicianSession> {
  const user = authUserSchema.parse(await request("/auth/v1/user", {}, token));
  const role = clinicianRole(user);
  if (!role) throw new AuthError("forbidden", "Clinician access is required");
  return { clinicianId: user.id, roles: [role], accessToken: token };
}

export async function requireClinician(options: { navigation?: boolean } = {}): Promise<ClinicianSession> {
  if (!options.navigation) await requireSameOrigin();
  const env = getEnv();
  if (env.AUTH_MODE === "dev" && env.NODE_ENV !== "production") {
    return { clinicianId: "dev-clinician", roles: ["clinician"] };
  }
  if (env.AUTH_MODE !== "supabase") throw new AuthError("unauthenticated", "Authentication is not configured");
  const h = await headers();
  const bearer = h.get("authorization");
  if (bearer && !/^Bearer \S+$/.test(bearer)) throw new AuthError("unauthenticated", "Invalid authorization header");
  const jar = await cookies();
  let token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : jar.get(ACCESS_COOKIE)?.value;
  const request = createSupabaseTransport();
  try {
    if (token) return await verifyClinician(token, request);
  } catch (error) {
    if (!(error instanceof SupabaseError) || ![401, 403].includes(error.status)) throw error;
    if (bearer) throw new AuthError("unauthenticated", "Session expired");
  }
  const refresh = !bearer && jar.get(REFRESH_COOKIE)?.value;
  if (!refresh) throw new AuthError("unauthenticated", "Sign in is required");
  try {
    const tokens = tokenSchema.parse(await request("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: refresh }) }));
    token = tokens.access_token;
    const session = await verifyClinician(token, request);
    await saveSession(tokens);
    return session;
  } catch (error) {
    if (error instanceof SupabaseError && [400, 401, 403].includes(error.status)) {
      await clearSession();
      throw new AuthError("unauthenticated", "Session expired; sign in again");
    }
    throw error;
  }
}
