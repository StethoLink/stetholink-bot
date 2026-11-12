import { RouteError } from "@/core/errors";
import { providerCallbackSchema } from "@/shared/schemas";
import type { ProviderResponseSink } from "./ports";

// Control and bidirectional-override characters, and markup, never belong in a stored report.
const unsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f‪-‮⁦-⁩]|<\/?[a-z][^>]*>/iu;

/**
 * Accepts a callback whose sender was already authenticated by the platform.
 * The body cannot choose its own identity, and correlation to the original request,
 * tenant and provider is enforced again by the durable store.
 */
export function createProviderResponseService(deps: { sink: ProviderResponseSink }) {
  return {
    async ingest(authenticatedProviderId: string, body: unknown) {
      const parsed = providerCallbackSchema.safeParse(body);
      if (!parsed.success) throw new RouteError("invalid_request", "Invalid provider callback");
      const callback = parsed.data;
      if (callback.providerId !== authenticatedProviderId) throw new RouteError("forbidden", "Callback does not belong to the authenticated provider");
      const text = [callback.reason, callback.report?.summary, callback.report?.responder, ...(callback.report?.recommendations ?? [])];
      if (text.some((value) => value !== undefined && unsafe.test(value))) throw new RouteError("invalid_request", "Invalid provider callback");
      return { requestId: callback.requestId, disposition: await deps.sink.record(callback) };
    },
  };
}
