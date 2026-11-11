import "server-only";
import { z } from "zod";
import type { TransactionSql } from "postgres";
import { consultationDraftSchema } from "@/shared/schemas";
import type { ConsultationRepository } from "@/core/consultation/repository";
import type { ClinicianContext } from "@/core/auth/clinician";
import { database } from "./database";

const rowSchema = z.object({
  id: z.string(), patient_id: z.string(), encounter_id: z.string().nullable(), status: z.string(),
  summary: z.string(), assessment: z.string(), plan: z.array(z.string()), generated_by: z.literal("ai"),
  created_at: z.date(), updated_at: z.date(), reviewed_by: z.string().nullable(), reviewed_at: z.date().nullable(),
});

function fromRow(value: unknown) {
  const row = rowSchema.parse(value);
  return consultationDraftSchema.parse({
    id: row.id, patientId: row.patient_id, encounterId: row.encounter_id ?? undefined,
    status: row.status, summary: row.summary, assessment: row.assessment, plan: row.plan,
    generatedBy: row.generated_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    reviewedBy: row.reviewed_by ?? undefined, reviewedAt: row.reviewed_at?.toISOString(),
  });
}

export function createConsultationRepository(context: ClinicianContext): ConsultationRepository {
  function scoped<T>(work: (tx: TransactionSql) => Promise<T>) {
    return database().begin(async (tx) => {
      await tx`select set_config('stetholink.context', ${JSON.stringify(context)}, true)`;
      return await work(tx);
    });
  }
  return {
    async get(id) {
      return scoped(async (tx) => {
        const [row] = await tx`select * from public.consultation_drafts where id = ${id}`;
        return row ? fromRow(row) : null;
      });
    },
    async create(draft, clinicianId, provenance) {
      return scoped(async (tx) => {
        const [row] = await tx`insert into public.consultation_drafts
          (id, tenant_id, clinician_id, patient_id, encounter_id, status, summary, assessment, plan, generated_by, provider, model, prompt_version)
          values (${draft.id}, ${context.tenantId}, ${clinicianId}, ${draft.patientId}, ${draft.encounterId ?? null}, 'pending_approval',
            ${draft.summary}, ${draft.assessment}, ${tx.json(draft.plan)}, 'ai', ${provenance.provider}, ${provenance.model},
            ${provenance.promptVersion}) returning *`;
        return fromRow(row);
      });
    },
    async approve(input) {
      return scoped(async (tx) => {
        const [row] = await tx`select * from public.record_ehr_consultation_approval(${input.draftId}, ${input.decision}, ${input.comment ?? null})`;
        return fromRow(row);
      });
    },
  };
}
