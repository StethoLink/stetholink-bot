import type { ConsultationDraft } from "@/shared/contracts";
import type { ConsultationRepository } from "@/core/consultation/repository";
import { RouteError } from "@/core/errors";

const globals = globalThis as typeof globalThis & {
  stetholinkMockDrafts?: Map<string, Map<string, ConsultationDraft>>;
};
const drafts = globals.stetholinkMockDrafts ??= new Map();

export function mockConsultationRepository(tenantId: string, clinicianId: string, patientId: string, encounterId?: string): ConsultationRepository {
  const scope = JSON.stringify([tenantId, clinicianId, patientId, encounterId]);
  const owned = drafts.get(scope) ?? new Map<string, ConsultationDraft>();
  drafts.set(scope, owned);
  return {
    async get(id) {
      return owned.get(id) ?? null;
    },
    async create(draft) {
      owned.set(draft.id, draft);
      return draft;
    },
    async approve(input) {
      const draft = owned.get(input.draftId);
      if (!draft) throw new RouteError("not_found", "Draft not found");
      if (draft.status !== "pending_approval") {
        throw new RouteError("conflict", "Draft has already been reviewed");
      }
      const now = new Date().toISOString();
      const updated: ConsultationDraft = {
        ...draft,
        status: input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "draft",
        reviewedAt: now,
        reviewedBy: clinicianId,
        updatedAt: now,
      };
      owned.set(updated.id, updated);
      return updated;
    },
  };
}
