import { ProviderTransportError, type ProviderTransport } from "@/core/routing/ports";
import { consultationEnvelopeSchema } from "@/shared/schemas";

/**
 * Transport for a specialist service that works inside StethoLink. The request is already
 * durable when this runs: the delivery attempt row holds the envelope under its request id, and
 * that row is the service's inbox entry. So there is nothing to transmit, and receiving the same
 * request twice is receiving it once. The reply comes back through the same callback contract
 * as any other provider.
 */
export function createPortalTransport(): ProviderTransport {
  return {
    kind: "portal",
    async send(envelope) {
      const received = consultationEnvelopeSchema.safeParse(envelope);
      if (!received.success) throw new ProviderTransportError("transport_error", "The request is not a valid consultation envelope");
      return { requestId: received.data.requestId, providerReference: `inbox:${received.data.requestId}` };
    },
  };
}
