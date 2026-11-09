import type { APPROVAL_DECISIONS, CONSULTATION_STATUSES } from "@/shared/constants";
import type { IsoDateTime } from "@/shared/types";

export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

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
}

/** Clinician decision on a draft. The clinician's identity comes from the server session. */
export interface ApprovalRequest {
  draftId: string;
  decision: ApprovalDecision;
  comment?: string;
}
