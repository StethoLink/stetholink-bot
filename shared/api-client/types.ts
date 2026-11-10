import type {
  ApprovalRequest,
  ChatRequest,
  ChatResponse,
  ConsultationDraft,
  CreateConsultationDraftRequest,
  EncounterContext,
  PatientContext,
} from "@/shared/contracts";
import type { HealthResponse } from "@/shared/schemas";

/** The frontend talks to the backend only through this interface. */
export interface StethoLinkApiClient {
  health(): Promise<HealthResponse>;
  sendChatMessage(request: ChatRequest): Promise<ChatResponse>;
  getPatientContext(patientId: string): Promise<PatientContext>;
  getEncounterContext(encounterId: string): Promise<EncounterContext>;
  createConsultationDraft(request: CreateConsultationDraftRequest): Promise<ConsultationDraft>;
  getConsultationDraft(draftId: string): Promise<ConsultationDraft>;
  submitApproval(request: ApprovalRequest): Promise<ConsultationDraft>;
}
