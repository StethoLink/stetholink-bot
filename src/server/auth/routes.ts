import "server-only";
import { z } from "zod";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ACCESS_COOKIE, REFRESH_COOKIE, clearSession, requireClinician, requireSameOrigin, saveSession } from "./session";
import { clinicianRole, createSupabaseTransport, SupabaseError, tokenSchema } from "./supabase";
import { contractResponse, errorResponse, handleRouteError } from "@/server/http/respond";

const credentialsSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(1024) });
const sessionSchema = z.object({ clinicianId: z.string().uuid(), roles: z.array(z.enum(["clinician", "admin"])) });

export function loginPage() {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>StethoLink sign in</title><body><main><h1>Sign in to StethoLink</h1><p>Use your clinician account.</p><form method="post" action="/api/auth/login"><label>Email <input type="email" name="email" autocomplete="username" required></label><br><label>Password <input type="password" name="password" autocomplete="current-password" required></label><br><button type="submit">Sign in</button></form></main></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" } });
}

export async function login(req: Request) {
  try {
    await requireSameOrigin();
    const form = req.headers.get("content-type")?.includes("application/x-www-form-urlencoded");
    const input: unknown = form ? Object.fromEntries(await req.formData()) : await req.json().catch(() => null);
    const parsed = credentialsSchema.safeParse(input);
    if (!parsed.success) return errorResponse("invalid_request", "Enter a valid email and password");
    const request = createSupabaseTransport();
    const tokens = tokenSchema.parse(await request("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify(parsed.data) }));
    const role = clinicianRole(tokens.user);
    if (!role) {
      await request("/auth/v1/logout?scope=local", { method: "POST" }, tokens.access_token);
      return errorResponse("forbidden", "Clinician access is required");
    }
    await saveSession(tokens);
    if (form) return NextResponse.redirect(new URL("/", req.url), 303);
    return contractResponse(sessionSchema, { clinicianId: tokens.user.id, roles: [role] });
  } catch (error) {
    if (error instanceof SupabaseError && [400, 401, 403].includes(error.status)) return errorResponse("unauthenticated", "Sign in failed");
    return handleRouteError(error);
  }
}

export async function logout() {
  try {
    await requireSameOrigin();
    const jar = await cookies();
    let token = jar.get(ACCESS_COOKIE)?.value;
    const refresh = jar.get(REFRESH_COOKIE)?.value;
    const request = createSupabaseTransport();
    if (refresh) {
      try {
        const tokens = tokenSchema.parse(await request("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: refresh }) }));
        token = tokens.access_token;
      } catch (error) { if (!(error instanceof SupabaseError) || ![400, 401, 403].includes(error.status)) throw error; }
    }
    if (token) {
      try { await request("/auth/v1/logout?scope=local", { method: "POST" }, token); }
      catch (error) { if (!(error instanceof SupabaseError) || ![401, 403].includes(error.status)) throw error; }
    }
    await clearSession();
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleRouteError(error); }
}

export async function session() {
  try {
    const user = await requireClinician();
    return contractResponse(sessionSchema, { clinicianId: user.clinicianId, roles: user.roles });
  } catch (error) { return handleRouteError(error); }
}
