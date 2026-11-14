import type { APPROVAL_DECISIONS, CONSULTATION_STATUSES } from "@/shared/constants";
import type { IsoDateTime } from "@/shared/types";
import type { AttachmentReference } from "./attachment";
import type { DataClassification } from "./classification";
import type { ClinicalFact, MissingInformation } from "./clinical-data";
import type { AdministrativeSex } from "./patient";

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

/** Additive M2 output. Generated from validated chart sources, never approval authority. */
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
    /** Set by the server from the verified session. Rows stored before this field read as "synthetic". */
    dataClassification: DataClassification;
    encounterReference: string | null;
  };
  /** Present when a language model wrote the draft from the physician's natural-language request. */
  authoring?: ConsultationAuthoring;
  /**
   * Derived by the server from the chart when the draft was written. Age is top-coded at
   * "90 years or older"; the name, birth date and chart identifiers are never included.
   * Absent on drafts stored before this field existed.
   */
  patient?: { age: string | null; sex: AdministrativeSex };
}

/** Why the assistant questions a consultation request before drafting it. */
export type RequestConcernKind = "missing_specialty" | "specialty_fit" | "unclear_question" | "missing_information" | "conflicts_with_chart" | "urgency";

/** One challenge to the request, grounded in the chart where it cites facts. */
export interface RequestConcern {
  kind: RequestConcernKind;
  /** What is wrong with the request, stated directly. */
  concern: string;
  /** What the physician is asked to answer. */
  question: string;
  /** Chart facts the concern is based on; empty when it is about the request itself. */
  evidenceIds: string[];
}

/** The physician's answer to one question the assistant asked. */
export interface ConsultationClarification {
  question: string;
  answer: string;
}

/**
 * Returned instead of a draft when the assistant questions the request. Nothing is stored.
 * The physician answers (the answers are sent back with the same request) or chooses to proceed.
 */
export interface ConsultationClarificationNeeded {
  outcome: "clarification_needed";
  specialty: string | null;
  concerns: RequestConcern[];
  /** Answers already given, in order; send them back with the next attempt. */
  clarifications: ConsultationClarification[];
  /** False once the maximum number of questions has been answered; only "proceed" remains. */
  canAnswer: boolean;
}

/** Token use for one model call. Cost is an estimate from operator-configured upper-bound rates. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  latencyMs: number;
  attempts: number;
}

/**
 * Record of the original generation. Every model statement was checked against the cited
 * chart facts before it was stored; the physician still reviews all of it.
 */
export interface ConsultationAuthoring {
  mode: "model_authored";
  /** The physician's request, verbatim. */
  physicianRequest: string;
  /** Model statements removed because they were not supported by the facts they cited. */
  rejectedStatements: number;
  /** False for the deterministic demo fallback, which performs no model inference. */
  liveInference: boolean;
  usage: ModelUsage | null;
  /** The physician's answers to the assistant's questions before this draft was written. */
  clarifications?: ConsultationClarification[];
  /** Concerns the assistant still raised when the physician chose to proceed. Shown with the draft, never sent to the provider. */
  overriddenConcerns?: RequestConcern[];
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
  approvedRecipientId?: string;
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
  recipientId?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
}

/** Natural-language revision by the model. Documented facts, sources, specialty and question cannot change. */
export interface ModelRevisionRequest {
  instruction: string;
  expectedVersion: number;
  idempotencyKey: string;
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
