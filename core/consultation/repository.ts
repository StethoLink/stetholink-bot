import type { ApprovalRequest, ConsultationDraft } from "@/shared/contracts";

export interface ConsultationRepository {
  get(id: string): Promise<ConsultationDraft | null>;
  create(draft: ConsultationDraft, clinicianId: string, provenance: {
    provider: string;
    model: string;
    promptVersion: string;
  }): Promise<ConsultationDraft>;
  approve(input: ApprovalRequest): Promise<ConsultationDraft>;
}
