import "server-only";
import { z } from "zod";
import type { TransactionSql } from "postgres";
import type { ClinicianContext } from "@/core/auth/clinician";
import { RouteError } from "@/core/errors";
import type { ExistingOrder } from "@/core/orders/flags";
import type { OrderRepository } from "@/core/orders/repository";
import type { OrderDraft, OrderLine } from "@/shared/contracts";
import { orderDraftListSchema, orderDraftSchema, orderLineSchema } from "@/shared/schemas";
import { scopedTo } from "./scoped";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const draftRow = z.object({
  id: z.string(), patient_id: z.string(), encounter_id: z.string(), mode: z.enum(["specific", "case_based"]), request: z.string(), catalog_version: z.string(),
  unmatched: z.array(z.string()), notes: z.array(z.string()), clinical_facts: z.array(z.unknown()), missing_information: z.array(z.unknown()), provenance: z.unknown(),
  version: z.number().int(), created_at: z.coerce.date(), updated_at: z.coerce.date(),
});
const lineRow = z.object({
  id: z.string(), catalog_item_id: z.string(), kind: z.string(), content: z.record(z.string(), z.unknown()), status: z.string(),
  decided_by: z.string().nullable(), decided_at: z.coerce.date().nullable(), acknowledged: z.array(z.string()).nullable(), override_reason: z.string().nullable(),
});

/** One line as the contract states it: the drafted content, with the decision from its own columns. */
export function orderLineFromRow(value: unknown): OrderLine {
  const row = lineRow.parse(value);
  return orderLineSchema.parse({
    ...row.content, id: row.id, catalogItemId: row.catalog_item_id, kind: row.kind, status: row.status,
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}), ...(row.decided_at ? { decidedAt: row.decided_at.toISOString() } : {}),
    ...(row.acknowledged ? { acknowledged: row.acknowledged } : {}), ...(row.override_reason ? { overrideReason: row.override_reason } : {}),
  });
}

export function orderDraftFromRows(draft: unknown, lines: readonly unknown[]): OrderDraft {
  const row = draftRow.parse(draft);
  return orderDraftSchema.parse({
    id: row.id, patientId: row.patient_id, encounterId: row.encounter_id, mode: row.mode, request: row.request, catalogVersion: row.catalog_version,
    lines: lines.map(orderLineFromRow), unmatched: row.unmatched, clinicalFacts: row.clinical_facts, missingInformation: row.missing_information, notes: row.notes,
    provenance: row.provenance, version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  });
}

/** Reads one draft with its lines, in the transaction that made it visible. */
export async function loadOrderDraft(tx: TransactionSql, draft: unknown): Promise<OrderDraft> {
  const { id } = z.object({ id: z.string() }).parse(draft);
  const lines = await tx`select * from public.order_lines where draft_id = ${id} order by position`;
  return orderDraftFromRows(draft, lines);
}

/**
 * Order drafts in PostgreSQL, bound to one verified session. Reads see only that clinician's drafts on that chart and
 * classification (row-level security); a draft is written only by `create_ehr_order_draft`, which checks the same session.
 */
export function createOrderRepository(context: ClinicianContext): OrderRepository {
  const scoped = scopedTo(context);
  return {
    async get(id) {
      if (!UUID.test(id)) return null;
      return scoped(async (tx) => {
        const [row] = await tx`select * from public.order_drafts where id = ${id}`;
        return row ? loadOrderDraft(tx, row) : null;
      });
    },
    async list() {
      return scoped(async (tx) => {
        const rows = await tx`select d.id, d.mode, d.request, d.version, d.created_at, d.updated_at,
            count(l.id)::int as lines, (count(l.id) filter (where l.status = 'pending'))::int as pending,
            (count(l.id) filter (where l.status = 'approved'))::int as approved, (count(l.id) filter (where l.status = 'rejected'))::int as rejected
          from public.order_drafts d left join public.order_lines l on l.draft_id = d.id
          group by d.id order by d.created_at desc limit 20`;
        return orderDraftListSchema.parse(rows.map((row) => ({
          id: row.id, mode: row.mode, request: row.request, lines: row.lines, pending: row.pending, approved: row.approved, rejected: row.rejected,
          version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
        })));
      });
    },
    async existing() {
      return scoped(async (tx) => {
        const rows = await tx`select catalog_item_id, status from public.encounter_order_items()`;
        return rows.map((row): ExistingOrder => ({ catalogItemId: row.catalog_item_id, status: row.status }));
      });
    },
    async replay(key, request) {
      return scoped(async (tx) => {
        // The fingerprint is compared as JSON, not as text: a string passed for a jsonb parameter would be encoded a second time.
        const [row] = await tx`select draft_id, (fingerprint = ${tx.json({ request } as never)}) as same from public.order_idempotency where action = 'create' and key = ${key}`;
        if (!row) return null;
        if (!row.same) throw new RouteError("conflict", "This idempotency key was already used for a different request");
        const [draft] = await tx`select * from public.order_drafts where id = ${row.draft_id}`;
        return draft ? loadOrderDraft(tx, draft) : null;
      });
    },
    async decide(input) {
      return scoped(async (tx) => {
        const [row] = await tx`select * from public.decide_ehr_order_lines(${input.draftId}, ${input.expectedVersion}, ${input.idempotencyKey}, ${tx.json(input.decisions as never)})`;
        return loadOrderDraft(tx, row);
      });
    },
    async create(draft, retry) {
      const payload = orderDraftSchema.parse(draft);
      return scoped(async (tx) => {
        const [row] = await tx`select * from public.create_ehr_order_draft(${tx.json(payload as never)}, ${tx.json(retry.request as never)}, ${retry.key})`;
        return loadOrderDraft(tx, row);
      });
    },
  };
}
