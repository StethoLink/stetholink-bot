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
