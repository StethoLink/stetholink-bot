import { contractResponse, errorResponse, handleRouteError } from "@/apps/embedded-app/server/http/respond";
import { receiveProviderCallback } from "@/apps/embedded-app/server/provider-callbacks";
import { allowRequest } from "@/platform/http/rate-limit";
import { callbackResultSchema } from "@/shared/schemas";

/**
 * Provider contract v1: signed status and report callbacks for a previously delivered request.
 * Server-to-server; no clinician cookie is read or required. Synthetic providers only.
 */
export async function POST(req: Request) {
  try {
    if (Number(req.headers.get("content-length") ?? 0) > 65_536) return errorResponse("invalid_request", "Callback is too large");
    // Before any signature work: at most 120 callbacks a minute per claimed provider and per sending address.
    const provider = (req.headers.get("x-stetholink-provider") ?? "unknown").slice(0, 128);
    const address = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    if (!allowRequest(`callback:${provider}`, 120, 60_000) || !allowRequest(`callback-from:${address}`, 240, 60_000)) {
      return new Response(JSON.stringify({ error: { code: "conflict", message: "Too many callbacks. Retry later" } }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60", "Cache-Control": "no-store" } });
    }
    return contractResponse(callbackResultSchema, await receiveProviderCallback(req.headers, await req.text()));
  } catch (error) {
    return handleRouteError(error);
  }
}
