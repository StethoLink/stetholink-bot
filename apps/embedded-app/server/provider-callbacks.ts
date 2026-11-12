import "server-only";
import { RouteError } from "@/core/errors";
import { createProviderResponseService } from "@/core/routing/responses";
import { auditConsultation } from "@/platform/audit";
import { AuthError } from "@/platform/auth/session";
import { createProviderResponseSink } from "@/platform/persistence";
import { providerCallbackSecret, syntheticRoutingEnabled } from "@/platform/providers";
import { CALLBACK_HEADERS, CALLBACK_MAX_BYTES, verifyProviderCallback } from "@/platform/providers/callback-auth";
import { getTenant } from "@/platform/tenants";
import { getEnv } from "@/platform/tenants/env";

/**
 * Single entry point for provider -> StethoLink messages. Order matters: authenticate the
 * sender, then validate the body, then let the database correlate it to the original request.
 */
export async function receiveProviderCallback(headers: Headers, rawBody: string) {
  if (!syntheticRoutingEnabled() || !getEnv().STETHOLINK_DATABASE_URL) throw new RouteError("not_found", "Route not found");
  const tenantId = getTenant().id;
  if (rawBody.length > CALLBACK_MAX_BYTES) throw new RouteError("invalid_request", "Callback is too large");
  const providerId = verifyProviderCallback(headers, rawBody, providerCallbackSecret);
  if (!providerId) {
    auditConsultation({ action: "provider.callback_refused", tenantId, reason: "authentication" });
    throw new AuthError("unauthenticated", "Provider authentication failed");
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new RouteError("invalid_request", "Invalid provider callback");
  }
  try {
    const result = await createProviderResponseService({ sink: createProviderResponseSink(tenantId) }).ingest(providerId, body);
    auditConsultation({ action: "provider.callback_recorded", tenantId, providerId, requestId: result.requestId, disposition: result.disposition });
    return result;
  } catch (error) {
    auditConsultation({ action: "provider.callback_refused", tenantId, providerId, reason: "rejected" });
    throw error;
  }
}

export { CALLBACK_HEADERS };
