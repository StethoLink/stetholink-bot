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
    async approve() {
      throw new RouteError("forbidden", "A verified physician session is required");
    },
  };
}
