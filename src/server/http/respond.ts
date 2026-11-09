import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import type { ApiErrorCode } from "@/shared/contracts";
import { AuthError } from "@/server/auth/session";

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
  return NextResponse.json({ error: { code, message } }, { status: STATUS[code] });
}

/** Validates the outgoing body against its contract. A contract violation is a server bug and returns 500. */
export function contractResponse<T>(schema: z.ZodType<T>, body: unknown, status = 200) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    console.error("Response contract violation", parsed.error.issues);
    return errorResponse("internal_error", "Response contract violation");
  }
  return NextResponse.json(parsed.data, { status });
}

export function handleRouteError(err: unknown) {
  if (err instanceof AuthError) return errorResponse(err.code, err.message);
  console.error(err);
  return errorResponse("internal_error", "Unexpected server error");
}
