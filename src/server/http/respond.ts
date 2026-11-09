import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import type { ApiErrorCode } from "@/shared/contracts";
import { AuthError } from "@/server/auth/session";
import { SupabaseError } from "@/server/auth/supabase";

export class RouteError extends Error {
  constructor(readonly code: ApiErrorCode, message: string) { super(message); }
}

const STATUS: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  safety_blocked: 422,
  not_implemented: 501,
  provider_unavailable: 503,
  internal_error: 500,
};

export function errorResponse(code: ApiErrorCode, message: string) {
  return NextResponse.json({ error: { code, message } }, { status: STATUS[code], headers: { "Cache-Control": "no-store" } });
}

/** Validates the outgoing body against its contract. A contract violation is a server bug and returns 500. */
export function contractResponse<T>(schema: z.ZodType<T>, body: unknown, status = 200) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    console.error("Response contract violation", parsed.error.issues.map(({ path, code }) => ({ path, code })));
    return errorResponse("internal_error", "Response contract violation");
  }
  return NextResponse.json(parsed.data, { status, headers: { "Cache-Control": "no-store" } });
}

export function handleRouteError(err: unknown) {
  if (err instanceof AuthError) return errorResponse(err.code, err.message);
  if (err instanceof RouteError) return errorResponse(err.code, err.message);
  if (err instanceof SupabaseError) {
    if (err.code === "P0002") return errorResponse("not_found", "Draft not found");
    if (err.code === "P0001" || err.status === 409) return errorResponse("conflict", "Draft cannot be reviewed in its current state");
    if (err.status === 401) return errorResponse("unauthenticated", "Sign in is required");
    if (err.status === 403) return errorResponse("forbidden", "Access denied");
    return errorResponse("provider_unavailable", "Database is temporarily unavailable");
  }
  console.error("Unhandled route error", err instanceof Error ? err.name : "unknown");
  return errorResponse("internal_error", "Unexpected server error");
}
