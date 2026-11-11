import type { IsoDateTime } from "@/shared/types";
import type { AttachmentReference } from "./attachment";
import type { ClinicalFact, MissingInformation } from "./clinical-data";
import type { ProviderId } from "./clinician";
import type { ConsultationGrounding, ConsultationStatus } from "./consultation";

/** Version of the provider-facing envelope and callback contracts. */
export type ProviderContractVersion = "1.0";

/** How a provider is reached. Portal and partner API reuse the same envelope and callback. */
export type ProviderTransportKind = "mock" | "portal" | "partner_api";

/** Directory entry for a receiving clinical service. Listing does not authorize a tenant to use it. */
export interface ProviderDescriptor {
  id: ProviderId;
  displayName: string;
  specialties: string[];
  transport: ProviderTransportKind;
  active: boolean;
  synthetic: boolean;
}

/** Physician-approved consultation content, before the durable request identity is assigned. */
export interface ConsultationEnvelopeContent {
  contractVersion: ProviderContractVersion;
  tenantId: string;
  providerId: ProviderId;
  specialty: string;
  reason: string | null;
  question: string;
  summary: string;
  assessment: string;
  plan: string[];
  clinicalFacts: ClinicalFact[];
  missingInformation: MissingInformation[];
  /** References and metadata only; never file or imaging bytes. */
  attachments: AttachmentReference[];
  safetyFlags: ConsultationGrounding["safetyFlags"];
  approval: { approvedBy: string; approvedAt: IsoDateTime };
  syntheticOnly: true;
}

/** What a provider receives. requestId is immutable and correlates every callback. */
export interface ConsultationEnvelope extends ConsultationEnvelopeContent {
  requestId: string;
  attempt: number;
}

export interface ProviderReport {
  summary: string;
  recommendations: string[];
  responder: string;
}

/** Provider -> StethoLink message. Identity comes from the verified signature, not this body. */
export interface ProviderCallback {
  contractVersion: ProviderContractVersion;
  requestId: string;
  providerId: ProviderId;
  /** Provider-chosen id; resending the same id is a safe no-op. */
  responseId: string;
  kind: "accepted" | "rejected" | "report";
  sentAt: IsoDateTime;
  reason?: string;
  report?: ProviderReport;
  syntheticOnly: true;
}

export type CallbackDisposition = "applied" | "ignored" | "duplicate";

export type DeliveryAttemptStatus = "queued" | "sent" | "accepted" | "responded" | "failed" | "cancelled" | "rejected";
export type DeliveryFailureCode = "transport_error" | "transport_timeout" | "invalid_acknowledgement" | "provider_rejected";

export interface DeliveryAttemptView {
  requestId: string;
  number: number;
  providerId: ProviderId;
  status: DeliveryAttemptStatus;
  failureCode?: DeliveryFailureCode;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ProviderResponseView {
  requestId: string;
  responseId: string;
  providerId: ProviderId;
  kind: ProviderCallback["kind"];
  receivedAt: IsoDateTime;
  reason?: string;
  report?: ProviderReport;
}

/** Clinician readback of routing, delivery and the specialist's reply. */
export interface ConsultationDeliveryView {
  draftId: string;
  version: number;
  status: ConsultationStatus;
  provider: Pick<ProviderDescriptor, "id" | "displayName" | "transport"> | null;
  attempts: DeliveryAttemptView[];
  responses: ProviderResponseView[];
  /** The specialist's report, when one has been received. */
  report: ProviderResponseView | null;
  canSend: boolean;
  canRetry: boolean;
  /** True only where the synthetic specialist simulator is available. */
  canSimulate: boolean;
}

/** Physician command. Identity and chart scope always come from the server session. */
export interface DispatchRequest {
  providerId: ProviderId;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface ConsultationListItem {
  id: string;
  status: ConsultationStatus;
  specialty: string | null;
  updatedAt: IsoDateTime;
}
