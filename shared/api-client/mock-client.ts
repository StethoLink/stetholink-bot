import type { ConsultationDraft } from "@/shared/contracts";
import { CONTRACT_VERSION } from "@/shared/constants";
import { syntheticDrafts, syntheticEncounters, syntheticPatients } from "@/shared/mocks/synthetic-data";
import {
  chatResponseSchema,
  consultationDraftSchema,
  encounterContextSchema,
  patientContextSchema,
} from "@/shared/schemas";
import { createId, nowIso } from "@/shared/utils";
import { ApiClientError } from "./errors";
import type { StethoLinkApiClient } from "./types";

/**
 * In-memory client backed by synthetic data, so the UI can be built before the backend exists.
 * Outputs are validated with the same schemas as the HTTP client.
 */
export function createMockApiClient(options: { latencyMs?: number } = {}): StethoLinkApiClient {
  const latency = options.latencyMs ?? 0;
  const drafts = new Map<string, ConsultationDraft>(syntheticDrafts.map((d) => [d.id, { ...d }]));
  const wait = () => new Promise((r) => setTimeout(r, latency));
  const notFound = (what: string) => new ApiClientError("not_found", `${what} not found`, 404);

  return {
    async health() {
      await wait();
      return { status: "ok", contractVersion: CONTRACT_VERSION };
    },
    async sendChatMessage(req) {
      await wait();
      return chatResponseSchema.parse({
        conversationId: req.conversationId ?? createId("conv"),
        message: {
          id: createId("msg"),
          role: "assistant",
          content: `[mock] I received: "${req.message}". This is synthetic output for UI development.`,
          createdAt: nowIso(),
        },
        safety: { level: "ok", reasons: [] },
        requiresClinicianReview: true,
      });
    },
    async getPatientContext(patientId) {
      await wait();
      const p = syntheticPatients.find((x) => x.patientId === patientId);
      if (!p) throw notFound("Patient");
      return patientContextSchema.parse(p);
    },
    async getEncounterContext(encounterId) {
      await wait();
      const e = syntheticEncounters.find((x) => x.encounterId === encounterId);
      if (!e) throw notFound("Encounter");
      return encounterContextSchema.parse(e);
    },
    async createConsultationDraft(req) {
      await wait();
      const now = nowIso();
      const draft = consultationDraftSchema.parse({
        id: createId("draft"),
        patientId: req.patientId,
        encounterId: req.encounterId,
        status: "pending_approval",
        summary: "[mock] Synthetic summary.",
        assessment: "[mock] Synthetic assessment.",
        plan: ["[mock] Synthetic plan item"],
        generatedBy: "ai",
        createdAt: now,
        updatedAt: now,
      });
      drafts.set(draft.id, draft);
      return draft;
    },
    async getConsultationDraft(draftId) {
      await wait();
      const d = drafts.get(draftId);
      if (!d) throw notFound("Draft");
      return d;
    },
    async submitApproval({ draftId, decision }) {
      await wait();
      const d = drafts.get(draftId);
      if (!d) throw notFound("Draft");
      if (d.status !== "pending_approval" && d.status !== "draft") {
        throw new ApiClientError("conflict", `Draft is already ${d.status}`, 409);
      }
      const now = nowIso();
      const status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "draft";
      const updated = consultationDraftSchema.parse({
        ...d,
        status,
        updatedAt: now,
        reviewedBy: "mock-clinician",
        reviewedAt: now,
      });
      drafts.set(draftId, updated);
      return updated;
    },
  };
}
