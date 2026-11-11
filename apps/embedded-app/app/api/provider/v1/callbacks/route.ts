import { contractResponse, errorResponse, handleRouteError } from "@/apps/embedded-app/server/http/respond";
import { receiveProviderCallback } from "@/apps/embedded-app/server/provider-callbacks";
import { callbackResultSchema } from "@/shared/schemas";

/**
 * Provider contract v1: signed status and report callbacks for a previously delivered request.
 * Server-to-server; no clinician cookie is read or required. Synthetic providers only.
 */
export async function POST(req: Request) {
  try {
    if (Number(req.headers.get("content-length") ?? 0) > 65_536) return errorResponse("invalid_request", "Callback is too large");
    return contractResponse(callbackResultSchema, await receiveProviderCallback(req.headers, await req.text()));
  } catch (error) {
    return handleRouteError(error);
  }
}
