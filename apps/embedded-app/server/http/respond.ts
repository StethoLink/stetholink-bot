import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import type { ApiErrorCode } from "@/shared/contracts";
import { AuthError } from "@/platform/auth/session";
import { newCorrelationId } from "@/platform/auth/smart-launch-failure";
import postgres from "postgres";

import { RouteError } from "@/core/errors";
import { ChartUnavailableError } from "@/core/tools/connector";
export { RouteError } from "@/core/errors";

const STATUS: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  safety_blocked: 422,
  unsupported_encounter: 422,
  not_implemented: 501,
  provider_unavailable: 503,
  internal_error: 500,
};

/** The caller already logged this failure under its own correlation ID (the SMART launch does). */
export interface Trace { correlationId: string }

/** Codes that mean something broke or is unreachable. A refusal, a missing record or a feature the hospital did not set up (`not_implemented`) is not a fault. */
const FAULTS: readonly ApiErrorCode[] = ["internal_error", "provider_unavailable"];

/**
 * A failure on the server's side (`internal_error`, `provider_unavailable`) carries a reference: `error.requestId` in the body and `X-Correlation-Id`,
 * the same value as one `api.request_failed` log line. The line holds the error code and the reference only:
 * no path, no identifier, no message. Any other answer (a refusal, a missing record, a conflict, a feature not set up) is not logged and has none.
 */
export function errorResponse(code: ApiErrorCode, message: string, trace?: Trace) {
  const headers: Record<string, string> = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  const correlationId = trace?.correlationId ?? (FAULTS.includes(code) ? newCorrelationId() : undefined);
  if (!correlationId) return NextResponse.json({ error: { code, message } }, { status: STATUS[code], headers });
  if (!trace) console.error(JSON.stringify({ action: "api.request_failed", code, correlationId, at: new Date().toISOString() }));
  headers["X-Correlation-Id"] = correlationId;
  return NextResponse.json({ error: { code, message, requestId: correlationId } }, { status: STATUS[code], headers });
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

export async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return null;
  return request.json().catch(() => null);
}

export function handleRouteError(err: unknown, trace?: Trace) {
  if (err instanceof AuthError) return errorResponse(err.code, err.message, trace);
  if (err instanceof RouteError) return errorResponse(err.code, err.message, trace);
  if (err instanceof ChartUnavailableError) return errorResponse(err.code, err.message, trace);
  if (err instanceof postgres.PostgresError) {
    if (err.code === "P0002") return errorResponse("not_found", "Draft not found", trace);
    if (err.code === "P0001") return errorResponse("conflict", "The command conflicts with the record's state, version or idempotency key", trace);
    if (err.code === "22023") return errorResponse("invalid_request", "Invalid command", trace);
    if (["23505", "40001", "40P01", "55P03"].includes(err.code)) return errorResponse("conflict", "The record changed; retry with the same idempotency key or reload");
    if (err.code === "42501") return errorResponse("forbidden", "Access denied", trace);
    return errorResponse("provider_unavailable", "Database is temporarily unavailable", trace);
  }
  console.error("Unhandled route error", err instanceof Error ? err.name : "unknown");
  return errorResponse("internal_error", "Unexpected server error", trace);
}
