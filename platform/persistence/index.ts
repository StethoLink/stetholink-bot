import "server-only";
import { z } from "zod";
import type { TransactionSql } from "postgres";
import { consultationDraftSchema, consultationHistorySchema } from "@/shared/schemas";
import type { DurableConsultationRepository } from "@/core/consultation/repository";
import type { DeliveryRepository, ProviderResponseSink } from "@/core/routing/ports";
import { consultationEnvelopeSchema, consultationListSchema, providerCallbackSchema } from "@/shared/schemas";
import type { ClinicianContext } from "@/core/auth/clinician";
import { RouteError } from "@/core/errors";
import { database } from "./database";

const rowSchema = z.object({
  id: z.string(), tenant_id: z.string(), patient_id: z.string(), encounter_id: z.string().nullable(), status: z.string(),
  summary: z.string(), assessment: z.string(), plan: z.array(z.string()), generated_by: z.literal("ai"),
  created_at: z.coerce.date(), updated_at: z.coerce.date(), reviewed_by: z.string().nullable(), reviewed_at: z.coerce.date().nullable(),
  version: z.number().int().positive(), clinical_metadata: z.object({
    grounding: consultationDraftSchema.shape.grounding,
    clinicalFacts: consultationDraftSchema.shape.clinicalFacts,
    missingInformation: consultationDraftSchema.shape.missingInformation,
    attachments: consultationDraftSchema.shape.attachments,
  }),
});

export function consultationFromRow(value: unknown) {
  const row = rowSchema.parse(value);
  const canonical = row.status === "pending_approval" ? "pending_review" : row.status;
  return consultationDraftSchema.parse({
    ...row.clinical_metadata,
    id: row.id, tenantId: row.tenant_id, version: row.version, lifecycleStatus: canonical,
    patientId: row.patient_id, encounterId: row.encounter_id ?? undefined,
    status: canonical === "pending_review" ? "pending_approval" : canonical,
    summary: row.summary, assessment: row.assessment, plan: row.plan,
    generatedBy: row.generated_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    reviewedBy: row.reviewed_by ?? undefined, reviewedAt: row.reviewed_at?.toISOString(),
  });
}

export function createConsultationRepository(context: ClinicianContext, recipients: ReadonlySet<string> = new Set()): DurableConsultationRepository & DeliveryRepository & {
  list(): Promise<import("zod").infer<typeof consultationListSchema>>;
} {
  function scoped<T>(work: (tx: TransactionSql) => Promise<T>) {
    return database().begin(async (tx) => {
      await tx`select set_config('statement_timeout', '10000', true), set_config('lock_timeout', '5000', true),
        set_config('stetholink.context', ${JSON.stringify(context)}, true),
        set_config('stetholink.recipients', ${JSON.stringify([...recipients])}, true)`;
      return await work(tx);
    });
  }
  return {
    async get(id) {
      return scoped(async (tx) => {
        const [row] = await tx`select * from public.consultation_drafts where id = ${id}`;
        return row ? consultationFromRow(row) : null;
      });
    },
    async create(draft, clinicianId, _provenance, retry) {
      if (clinicianId !== context.clinicianId) throw new RouteError("forbidden", "Draft owner must match the session");
      return scoped(async (tx) => {
        const request = retry?.request ?? { patientId: draft.patientId, encounterId: draft.encounterId };
        const payload = consultationDraftSchema.parse(draft);
        const [row] = await tx`select * from public.create_ehr_consultation(${tx.json(payload)}, ${tx.json(request)}, ${retry?.key ?? null})`;
        return consultationFromRow(row);
      });
    },
    async approve(input) {
      return scoped(async (tx) => {
        const [row] = await tx`select * from public.approve_ehr_consultation_versioned(${input.draftId}, ${input.decision},
          ${input.comment ?? null}, ${input.expectedVersion ?? null}, ${input.idempotencyKey ?? null})`;
        return consultationFromRow(row);
      });
    },
    async revise(id, input) {
      return scoped(async (tx) => {
        const { expectedVersion, idempotencyKey, ...payload } = input;
        const [row] = await tx`select * from public.change_ehr_consultation(${id}, 'revise', ${expectedVersion}, ${idempotencyKey}, ${tx.json(payload)})`;
        return consultationFromRow(row);
      });
    },
    async transition(id, input) {
      return scoped(async (tx) => {
        const { action, expectedVersion, idempotencyKey } = input;
        const payload = {};
        const [row] = await tx`select * from public.change_ehr_consultation(${id}, ${action}, ${expectedVersion}, ${idempotencyKey}, ${tx.json(payload)})`;
        return consultationFromRow(row);
      });
    },
    async history(id, beforeVersion = 2147483647) {
      return scoped(async (tx) => {
        if (!(await tx`select id from public.consultation_drafts where id=${id}`).length) throw new RouteError("not_found", "Draft not found");
        // Bounded pages keep serverless response and execution sizes predictable.
        const rows = await tx`select version,snapshot from public.consultation_revisions where draft_id=${id}
          and version<${beforeVersion} order by version desc limit 21`;
        const page = rows.slice(0, 20);
        const lower = page.at(-1)?.version ?? beforeVersion;
        const events = await tx`select * from public.consultation_events where draft_id=${id}
          and version>=${lower} and version<${beforeVersion} order by version desc limit 20`;
        const attempts = await tx`select * from public.consultation_delivery_attempts where draft_id=${id} order by attempt_number desc limit 20`;
        return consultationHistorySchema.parse({
          revisions: page.map((r) => ({ version: r.version, draft: consultationFromRow(r.snapshot) })),
          events: events.map((e) => ({ version: e.version, type: e.event_type, fromStatus: e.from_status, toStatus: e.to_status, at: e.recorded_at.toISOString() })),
          attempts: attempts.map((a) => ({ id: a.id, number: a.attempt_number, recipientId: a.recipient_id, status: a.status,
            createdAt: a.created_at.toISOString(), updatedAt: a.updated_at.toISOString(), transport: a.transport })),
          nextBeforeVersion: rows.length>20 ? lower : null,
        });
      });
    },
    async list() {
      return scoped(async (tx) => {
        const rows = await tx`select id,status,updated_at,clinical_metadata->'grounding'->>'specialty' as specialty
          from public.consultation_drafts order by updated_at desc limit 20`;
        return consultationListSchema.parse(rows.map((r) => ({ id: r.id, specialty: r.specialty ?? null, updatedAt: r.updated_at.toISOString(),
          status: r.status === "pending_approval" ? "pending_review" : r.status })));
      });
    },
    async dispatch(id, input) {
      return scoped(async (tx) => {
        const [row] = await tx`select * from public.dispatch_ehr_consultation(${id}, ${input.expectedVersion}, ${input.idempotencyKey},
          ${input.providerId}, ${tx.json(input.envelope as never)})`;
        return consultationFromRow(row);
      });
    },
    async recordDispatchResult(requestId, result) {
      return scoped(async (tx) => {
        const [row] = await tx`select * from public.record_ehr_dispatch_result(${requestId}, ${result.outcome},
          ${result.outcome === "sent" ? result.providerReference : null}, ${result.outcome === "failed" ? result.failureCode : null})`;
        return consultationFromRow(row);
      });
    },
    async deliveries(id) {
      return scoped(async (tx) => {
        const rows = await tx`select * from public.consultation_delivery_attempts where draft_id=${id} order by attempt_number desc limit 20`;
        return rows.map((a) => {
          const envelope = consultationEnvelopeSchema.safeParse(a.envelope);
          return { requestId: a.id, number: a.attempt_number, providerId: a.recipient_id, status: a.status,
            failureCode: a.failure_code ?? undefined, createdAt: a.created_at.toISOString(), updatedAt: a.updated_at.toISOString(),
            envelope: envelope.success ? envelope.data : null };
        });
      });
    },
    async responses(id) {
      return scoped(async (tx) => {
        const rows = await tx`select * from public.consultation_provider_responses where draft_id=${id} order by received_at asc limit 50`;
        return rows.map((r) => {
          const callback = providerCallbackSchema.parse(r.payload);
          return { requestId: r.request_id, responseId: r.response_id, providerId: r.provider_id, kind: callback.kind,
            receivedAt: r.received_at.toISOString(), reason: callback.reason, report: callback.report };
        });
      });
    },
  };
}

/**
 * Stores a provider callback that the platform has already authenticated. No clinician
 * session exists here; the database binds the callback to this tenant, the original
 * request and the provider it was sent to.
 */
export function createProviderResponseSink(tenantId: string): ProviderResponseSink {
  return {
    async record(callback) {
      return database().begin(async (tx) => {
        await tx`select set_config('statement_timeout', '10000', true), set_config('lock_timeout', '5000', true)`;
        const [row] = await tx`select public.record_provider_callback(${tenantId}, ${callback.requestId}, ${callback.providerId},
          ${callback.responseId}, ${callback.kind}, ${tx.json(callback as never)}) as result`;
        return z.object({ disposition: z.enum(["applied", "ignored", "duplicate"]) }).parse(row.result).disposition;
      });
    },
  };
}
