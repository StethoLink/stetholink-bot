import { z } from "zod";
import type { InteractionRule, OrderCatalog, OrderCatalogItem, OrderDecisionRequest, OrderDraft, OrderFlag, OrderLine, OrderSet } from "@/shared/contracts";
import { dataClassificationSchema } from "./classification";
import { clinicalFactSchema, missingInformationSchema } from "./clinical-data";

const id = z.string().min(1).max(128).regex(/\S/);
const label = z.string().min(1).max(200).regex(/\S/);
const isoDateTime = z.string().datetime({ offset: true });
const orderKind = z.enum(["lab", "imaging", "medication", "nursing"]);
const flagKind = z.enum(["allergy", "allergies_unchecked", "duplicate_active", "duplicate_order", "interaction", "interactions_unchecked"]);
const words = z.array(label).max(40);

/** The tenant's approved order catalog. Parsed from the operator's own configuration, never from a request. */
export const orderCatalogItemSchema = z.object({
  id,
  kind: orderKind,
  display: label,
  synonyms: words,
  code: z.object({ system: z.string().min(1).max(200), code: z.string().min(1).max(64), display: z.string().max(200).optional() }).strict().optional(),
  medication: z.object({ product: label, dose: label, route: label, frequency: label, duration: z.string().min(1).max(100).optional() }).strict().optional(),
  matchTerms: words,
  groups: z.array(id).max(20),
  allergyTerms: words,
}).strict().superRefine((item, ctx) => {
  // A medication order is the catalog's product at the catalog's dose, or it is not an order.
  if (item.kind === "medication" && !item.medication) ctx.addIssue({ code: "custom", message: "A medication needs its product, dose, route and frequency", path: ["medication"] });
  if (item.kind !== "medication" && item.medication) ctx.addIssue({ code: "custom", message: "Only a medication carries a dose", path: ["medication"] });
}) satisfies z.ZodType<OrderCatalogItem>;

export const orderSetSchema = z.object({ id, name: label, synonyms: words, itemIds: z.array(id).min(1).max(60) }).strict() satisfies z.ZodType<OrderSet>;
export const interactionRuleSchema = z.object({
  groups: z.tuple([id, id]), severity: z.enum(["major", "moderate", "minor"]), text: z.string().min(1).max(500),
}).strict() satisfies z.ZodType<InteractionRule>;

export const orderCatalogSchema = z.object({
  version: z.string().min(1).max(64),
  items: z.array(orderCatalogItemSchema).min(1).max(2000),
  sets: z.array(orderSetSchema).max(200),
  interactions: z.array(interactionRuleSchema).max(2000),
}).strict().superRefine((catalog, ctx) => {
  const ids = new Set<string>();
  for (const [index, item] of catalog.items.entries()) {
    if (ids.has(item.id)) ctx.addIssue({ code: "custom", message: "Duplicate order id", path: ["items", index, "id"] });
    ids.add(item.id);
  }
  for (const [index, set] of catalog.sets.entries()) {
    for (const itemId of set.itemIds) if (!ids.has(itemId)) ctx.addIssue({ code: "custom", message: "An order set names an order that is not in the catalog", path: ["sets", index, "itemIds"] });
  }
}) satisfies z.ZodType<OrderCatalog>;

export const orderFlagSchema = z.object({
  kind: flagKind, severity: z.enum(["major", "moderate", "minor"]).optional(), text: z.string().min(1).max(500), evidenceIds: z.array(id).max(32),
}).strict() satisfies z.ZodType<OrderFlag>;

export const orderLineSchema = z.object({
  id, catalogItemId: id, kind: orderKind, display: label,
  code: orderCatalogItemSchema.shape.code.optional(), medication: z.object({ product: label, dose: label, route: label, frequency: label, duration: z.string().min(1).max(100).optional() }).strict().optional(),
  basis: z.enum(["requested", "proposed"]), requestedText: z.string().max(300).optional(),
  reason: z.string().min(1).max(600), evidenceIds: z.array(id).max(32), flags: z.array(orderFlagSchema).max(20),
  status: z.enum(["pending", "approved", "rejected"]),
  decidedBy: id.optional(), decidedAt: isoDateTime.optional(), acknowledged: z.array(flagKind).max(6).optional(), overrideReason: z.string().max(500).optional(),
}).strict() satisfies z.ZodType<OrderLine>;

export const orderDraftSchema = z.object({
  id, patientId: id, encounterId: id.optional(), mode: z.enum(["specific", "case_based"]), request: z.string().min(1).max(2000), catalogVersion: z.string().min(1).max(64),
  lines: z.array(orderLineSchema).max(40), unmatched: z.array(z.string().max(300)).max(20),
  clinicalFacts: z.array(clinicalFactSchema).max(80), missingInformation: z.array(missingInformationSchema).max(80), notes: z.array(z.string().max(1000)).max(40),
  provenance: z.object({ provider: z.string().min(1).max(100), model: z.string().min(1).max(200), promptVersion: z.string().min(1).max(64), dataClassification: dataClassificationSchema, rejectedLines: z.number().int().min(0) }).strict(),
  version: z.number().int().min(0), createdAt: isoDateTime, updatedAt: isoDateTime,
}).strict() satisfies z.ZodType<OrderDraft>;

export const orderDecisionRequestSchema = z.object({
  draftId: id, expectedVersion: z.number().int().min(0), idempotencyKey: id,
  decisions: z.array(z.object({
    lineId: id, decision: z.enum(["approve", "reject"]), acknowledged: z.array(flagKind).max(6).optional(), overrideReason: z.string().max(500).optional(),
  }).strict()).min(1).max(40),
}).strict() satisfies z.ZodType<OrderDecisionRequest>;
