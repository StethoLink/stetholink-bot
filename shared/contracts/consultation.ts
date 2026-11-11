import type { APPROVAL_DECISIONS, CONSULTATION_STATUSES } from "@/shared/constants";
import type { IsoDateTime } from "@/shared/types";
import type { AttachmentReference } from "./attachment";
import type { ClinicalFact, MissingInformation } from "./clinical-data";

/** Normalized consultation intent; not a new HTTP endpoint or an approval command. */
export interface ConsultationRequest {
  patientId: string;
  encounterId?: string;
  specialty: string;
  clinicalQuestion: string;
  attachments?: AttachmentReference[];
}

export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** Additive M2 output. Generated from validated synthetic sources, never approval authority. */
export interface ConsultationGrounding {
  reason: string | null;
  question: string | null;
  specialty: string | null;
  evidenceIds: string[];
  gaps: string[];
  conflicts: string[][];
  safetyFlags: Array<"clinician_review_required" | "conflicting_facts" | "missing_investigations" | "incomplete_referral" | "insufficient_clinical_data">;
  provenance: {
    provider: string;
    model: string;
    promptVersion: string;
    contextVersion: string;
    syntheticOnly: true;
    encounterReference: string | null;
  };
}

/** AI-generated draft. Stays a draft until a clinician approves it. */
export interface ConsultationDraft {
  id: string;
  patientId: string;
  encounterId?: string;
  status: ConsultationStatus;
  summary: string;
  assessment: string;
  plan: string[];
  generatedBy: "ai";
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Set by the server from the authenticated session, never by the client. */
  reviewedBy?: string;
  reviewedAt?: IsoDateTime;
  clinicalFacts?: ClinicalFact[];
  missingInformation?: MissingInformation[];
  attachments?: AttachmentReference[];
  grounding?: ConsultationGrounding;
  /** Durable aggregate identity and optimistic concurrency token (absent on legacy previews). */
  tenantId?: string;
  version?: number;
  /** Canonical state; status retains pending_approval for existing HTTP clients. */
  lifecycleStatus?: ConsultationStatus;
}

/** Clinician decision on a draft. The clinician's identity comes from the server session. */
export interface ApprovalRequest {
  draftId: string;
  decision: ApprovalDecision;
  comment?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
}

export interface RevisionRequest {
  expectedVersion: number;
  idempotencyKey: string;
  summary: string;
  assessment: string;
  plan: string[];
}

/**
 * Clinician lifecycle commands only. Approval stays on the physician approval path;
 * delivery and provider outcomes come from the router and verified provider callbacks.
 */
export interface TransitionRequest {
  expectedVersion: number;
  idempotencyKey: string;
  action: "submit" | "cancel";
}
