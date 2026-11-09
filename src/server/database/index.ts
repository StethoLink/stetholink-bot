import "server-only";
import { z } from "zod";
import { consultationDraftSchema } from "@/shared/schemas";
import type { ApprovalRequest, ConsultationDraft } from "@/shared/contracts";
import { createSupabaseTransport } from "@/server/auth/supabase";

const rowSchema = z.object({
  id: z.string(), patient_id: z.string(), encounter_id: z.string().nullable(), status: z.string(),
  summary: z.string(), assessment: z.string(), plan: z.array(z.string()), generated_by: z.literal("ai"),
  created_at: z.string(), updated_at: z.string(), reviewed_by: z.string().nullable(), reviewed_at: z.string().nullable(),
});
function fromRow(value: unknown): ConsultationDraft {
  const row = rowSchema.parse(value);
  return consultationDraftSchema.parse({
    id: row.id, patientId: row.patient_id, encounterId: row.encounter_id ?? undefined,
    status: row.status, summary: row.summary, assessment: row.assessment, plan: row.plan,
    generatedBy: row.generated_by, createdAt: row.created_at, updatedAt: row.updated_at,
    reviewedBy: row.reviewed_by ?? undefined, reviewedAt: row.reviewed_at ?? undefined,
  });
}

export function createConsultationRepository(token: string, request = createSupabaseTransport()) {
  return {
    async get(id: string) {
      const rows = z.array(z.unknown()).parse(await request(`/rest/v1/consultation_drafts?select=*&id=eq.${encodeURIComponent(id)}&limit=1`, {}, token));
      return rows.length ? fromRow(rows[0]) : null;
    },
    async create(draft: ConsultationDraft, clinicianId: string, provenance: { provider: string; model: string; promptVersion: string }) {
      const rows = z.array(z.unknown()).parse(await request("/rest/v1/consultation_drafts", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ id: draft.id, clinician_id: clinicianId, patient_id: draft.patientId,
          encounter_id: draft.encounterId ?? null, status: "pending_approval", summary: draft.summary,
          assessment: draft.assessment, plan: draft.plan, generated_by: "ai", provider: provenance.provider,
          model: provenance.model, prompt_version: provenance.promptVersion }),
      }, token));
      return fromRow(rows[0]);
    },
    async approve(input: ApprovalRequest) {
      const rows = z.array(z.unknown()).parse(await request("/rest/v1/rpc/record_consultation_approval", {
        method: "POST", body: JSON.stringify({ p_draft_id: input.draftId, p_decision: input.decision, p_comment: input.comment ?? null }),
      }, token));
      return fromRow(rows[0]);
    },
  };
}
export type ConsultationRepository = ReturnType<typeof createConsultationRepository>;
