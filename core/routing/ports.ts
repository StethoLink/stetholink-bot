import type {
  CallbackDisposition, ConsultationDraft, ConsultationEnvelope, ConsultationEnvelopeContent, DeliveryAttemptView,
  DeliveryFailureCode, DispatchRequest, ProviderCallback, ProviderDescriptor, ProviderResponseView, ProviderTransportKind,
} from "@/shared/contracts";

/** Tenant-scoped directory: only providers this tenant is allowed to route to. */
export interface ProviderRegistry {
  list(): Promise<ProviderDescriptor[]>;
}

export type TransportFailure = Exclude<DeliveryFailureCode, "provider_rejected">;

export class ProviderTransportError extends Error {
  constructor(readonly code: TransportFailure, message: string) {
    super(message);
  }
}

/**
 * Provider-neutral outbound channel. Implementations must treat envelope.requestId as an
 * idempotency key: receiving the same request twice has the effect of receiving it once.
 * Approval, eligibility and allowlisting are decided before a transport is ever called.
 */
export interface ProviderTransport {
  readonly kind: ProviderTransportKind;
  send(envelope: ConsultationEnvelope): Promise<{ requestId: string; providerReference: string }>;
}

/**
 * Everything provider-specific lives behind this interface, outside the Core:
 * how to authenticate, what the provider's wire format is, and how its answers arrive.
 * The Core only ever sees the versioned envelope going out and normalized callbacks coming in.
 */
export interface ProviderAdapter extends ProviderTransport {
  /** Request formats this adapter can produce, e.g. "stetholink.envelope.v1". */
  readonly formats: readonly string[];
  /**
   * For providers that cannot call back: fetch what has happened to one request.
   * Returns normalized callbacks; the response service deduplicates and correlates them.
   */
  poll?(request: { requestId: string; providerReference: string }): Promise<ProviderCallback[]>;
  /**
   * For providers that push in their own format: convert one authenticated inbound message.
   * Must throw on anything it cannot map exactly; it never fills in missing content.
   */
  normalize?(raw: unknown): ProviderCallback;
}

export interface DeliveryRecord extends DeliveryAttemptView {
  envelope: ConsultationEnvelope | null;
}

/** Durable delivery state. Every method is scoped to the verified clinician's chart. */
export interface DeliveryRepository {
  get(draftId: string): Promise<ConsultationDraft | null>;
  /** Atomically records the request for an approved consultation; replays are no-ops. */
  dispatch(draftId: string, input: DispatchRequest & { envelope: ConsultationEnvelopeContent }): Promise<ConsultationDraft>;
  recordDispatchResult(requestId: string, result:
    | { outcome: "sent"; providerReference: string }
    | { outcome: "failed"; failureCode: TransportFailure }): Promise<ConsultationDraft>;
  /** Newest attempt first. */
  deliveries(draftId: string): Promise<DeliveryRecord[]>;
  /** Oldest response first. */
  responses(draftId: string): Promise<ProviderResponseView[]>;
}

/** Tenant-bound store for verified provider callbacks; correlation is enforced durably. */
export interface ProviderResponseSink {
  record(callback: ProviderCallback): Promise<CallbackDisposition>;
}
