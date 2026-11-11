import type { ApprovalRequest, ConsultationDraft } from "@/shared/contracts";

export interface ConsultationRepository {
  get(id: string): Promise<ConsultationDraft | null>;
  create(draft: ConsultationDraft, clinicianId: string, provenance: {
    provider: string;
    model: string;
    promptVersion: string;
  }, retry?: { key: string; request: { patientId: string; encounterId?: string } }): Promise<ConsultationDraft>;
  approve(input: ApprovalRequest): Promise<ConsultationDraft>;
}


export interface DurableConsultationRepository extends ConsultationRepository {
  dispatch(id: string, input: import("@/shared/contracts/consultation").DispatchRequest): Promise<ConsultationDraft>;
  revise(id: string, input: import("@/shared/contracts/consultation").RevisionRequest): Promise<ConsultationDraft>;
  transition(id: string, input: import("@/shared/contracts/consultation").TransitionRequest): Promise<ConsultationDraft>;
  history(id: string, beforeVersion?: number): Promise<import("zod").infer<typeof import("@/shared/schemas").consultationHistorySchema>>;
}
