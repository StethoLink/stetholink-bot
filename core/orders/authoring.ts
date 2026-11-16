import { z } from "zod";
import type { ClinicalFact, KnownClinicalFact, OrderCatalog, OrderCatalogItem, OrderMode } from "@/shared/contracts";
import { RouteError } from "@/core/errors";
import type { PatientDemographics } from "@/core/consultation/demographics";
import { PRIVACY_NOTE } from "@/core/privacy/provider";
import { containsPhrase } from "./text";

export const ORDERS_PROMPT_VERSION = "order-authoring@1.0.0";
export const ORDERS_TASK = "order_drafting";
export const MAX_ORDER_ATTEMPTS = 2;
export const MAX_SPECIFIC_ORDERS = 30;
export const MAX_PROPOSED_ORDERS = 12;

/**
 * The model chooses entries of the hospital's order catalog; this module decides what survives.
 * Nothing the model says is trusted: an id that is not in the catalog is dropped, an order the physician did not
 * ask for is dropped from a specific request, and a proposed order without a cited chart fact is dropped.
 * The code, product and dose of an order are copied from the catalog afterwards, never taken from the model.
 */
export const ORDER_INSTRUCTIONS = [
  "You are the order drafting component of StethoLink. You prepare DRAFT orders that a licensed physician will review and approve or reject one by one. You do not sign, send or place anything.",
  "The user message is one JSON object. request is the physician's own words. chart.facts is the complete documented record for this request; patient gives age and sex; visit.reason is the reason for the visit. catalog.items lists the only orders that exist for this hospital (id, kind, display, synonyms); catalog.sets lists the hospital's order sets (id, name, synonyms, itemIds).",
  "Rules:",
  "1. Choose orders only by catalog item id, exactly as written in catalog.items. Never invent an id, a code, a product, a dose or a route, and never write one in any text. An order that is not in the catalog cannot be drafted: put the physician's words for it in unmatched.",
  "2. When the request names the orders it wants (for example \"prepare a CBC and a chest X-ray\"), mode is \"specific\". Return exactly those orders, no others: for each, itemId is its catalog id and requestedText is the words of the request that name it, copied unchanged. Use catalog synonyms to match the physician's words, including Arabic names. reason is one short sentence; evidenceIds lists chart fact ids that bear on it, or is empty.",
  "3. When the request asks for orders for the case without naming them (for example \"prepare the basic orders for this case\", or it describes the problem), mode is \"case_based\". If the request names an order set, choose items from that set only. Otherwise choose the catalog orders that the documented chart facts make relevant, at most 12. Each item needs reason (one sentence using only what the cited facts say) and evidenceIds with at least one chart fact id whose status is \"known\". Leave requestedText empty. Propose nothing the chart does not support.",
  "4. If a request mixes both, use \"case_based\" and give requestedText for the orders the physician named.",
  "5. If you cannot match the request to the catalog at all, mode is \"unclear\", items is empty, and unmatched lists the physician's words.",
  "6. Never cite a fact whose status is \"unknown\". Keep every text value short, without square brackets, markup or line breaks. State no result, diagnosis, recommendation or treatment of your own.",
].join("\n");

/** Strict structured-output schema: every property required, nothing additional. */
export const orderFormat = {
  name: ORDERS_TASK,
  schema: {
    type: "object", additionalProperties: false, required: ["mode", "items", "unmatched"],
    properties: {
      mode: { type: "string", enum: ["specific", "case_based", "unclear"] },
      items: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["itemId", "requestedText", "reason", "evidenceIds"],
          properties: { itemId: { type: "string" }, requestedText: { type: "string" }, reason: { type: "string" }, evidenceIds: { type: "array", items: { type: "string" } } },
        },
      },
      unmatched: { type: "array", items: { type: "string" } },
    },
  },
};

const text = (max: number) => z.string().max(max);
const outputSchema = z.object({
  mode: z.enum(["specific", "case_based", "unclear"]),
  items: z.array(z.object({ itemId: text(128), requestedText: text(300), reason: text(600), evidenceIds: z.array(text(128)).max(16) }).strict()).max(60),
  unmatched: z.array(text(300)).max(20),
}).strict();

export interface OrderAuthoringContext {
  request: string;
  demographics: PatientDemographics | null;
  reasonForVisit: string | null;
  facts: readonly ClinicalFact[];
  eligibleFacts: readonly KnownClinicalFact[];
  catalog: OrderCatalog;
}

/** What the model receives: the physician's words, the chart's facts and the catalog's names. No codes, doses, name or identifiers. */
export function buildOrderInput(context: OrderAuthoringContext): string {
  const brief = (item: OrderCatalogItem) => ({ id: item.id, kind: item.kind, display: item.display, synonyms: item.synonyms });
  return JSON.stringify({
    request: context.request,
    patient: context.demographics ? { age: context.demographics.age, sex: context.demographics.sex } : null,
    visit: { reason: context.reasonForVisit },
    chart: {
      facts: context.facts.map((fact) => fact.status === "known"
        ? { id: fact.id, category: fact.category, label: fact.label, status: "known", value: fact.value, ...(fact.unit ? { unit: fact.unit } : {}) }
        : { id: fact.id, category: fact.category, label: fact.label, status: "unknown", reason: fact.reason }),
    },
    catalog: { items: context.catalog.items.map(brief), sets: context.catalog.sets.map(({ id, name, synonyms, itemIds }) => ({ id, name, synonyms, itemIds })) },
  });
}

/** What the chart's facts add to the request to the model for a typical chart (a few thousand bytes). A chart with many facts needs more, and the provider refuses a request over its limit. */
export const ORDER_FACTS_ALLOWANCE_BYTES = 6_000;

/**
 * Bytes of the model request before the chart's facts: instructions, the privacy note the de-identification layer adds,
 * the output schema, the catalog, and a request of 300 letters and a visit reason of 100, written in Arabic (two bytes a letter).
 * A catalog whose floor plus `ORDER_FACTS_ALLOWANCE_BYTES` exceeds the model input limit leaves no room for a chart, so it is refused when the server starts.
 */
export function orderRequestFloorBytes(catalog: OrderCatalog): number {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  const input = buildOrderInput({ request: "ع".repeat(300), demographics: { age: "90 years or older", sex: "unknown" }, reasonForVisit: "ع".repeat(100), facts: [], eligibleFacts: [], catalog });
  return bytes(ORDER_INSTRUCTIONS) + bytes(PRIVACY_NOTE) + bytes(JSON.stringify(orderFormat.schema)) + bytes(input) + 1024;
}

export interface ValidatedOrderLine {
  item: OrderCatalogItem;
  basis: "requested" | "proposed";
  requestedText?: string;
  reason: string;
  evidenceIds: string[];
}
export interface ValidatedOrders { mode: OrderMode | "unclear"; lines: ValidatedOrderLine[]; unmatched: string[]; rejected: number }

const names = (item: OrderCatalogItem) => [item.display, ...item.synonyms];
const squash = (value: string) => value.replace(/[\[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Keeps what the catalog, the physician's request and the chart support, and counts what it drops.
 * A specific request yields only orders whose catalog name (or a synonym) the physician actually wrote.
 */
export function validateOrders(raw: string, context: OrderAuthoringContext): ValidatedOrders {
  let parsed: z.infer<typeof outputSchema>;
  try { parsed = outputSchema.parse(JSON.parse(raw)); }
  catch { throw new RouteError("provider_unavailable", "Model returned an invalid order selection"); }
  const byId = new Map(context.catalog.items.map((item) => [item.id, item]));
  const eligible = new Set(context.eligibleFacts.map((fact) => fact.id));
  const unmatched = parsed.unmatched.map(squash).filter(Boolean);
  if (parsed.mode === "unclear") return { mode: "unclear", lines: [], unmatched, rejected: parsed.items.length };

  // An order set named in the request limits what a case-based request may propose.
  const namedSets = context.catalog.sets.filter((set) => [set.name, ...set.synonyms].some((name) => containsPhrase(context.request, name)));
  const inNamedSet = new Set(namedSets.flatMap((set) => set.itemIds));
  const lines: ValidatedOrderLine[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const entry of parsed.items) {
    const item = byId.get(entry.itemId);
    // Only the catalog's own ids, once each.
    if (!item) { rejected++; continue; }
    if (seen.has(item.id)) continue;
    const asked = names(item).find((name) => containsPhrase(context.request, name));
    // An order the physician named does not depend on the model's sentence: without one, their own words are the reason.
    const reason = squash(entry.reason) || (asked ? squash(asked) : "");
    const evidenceIds = [...new Set(entry.evidenceIds)].filter((id) => eligible.has(id));
    if (!reason) { rejected++; continue; }
    if (asked) {
      // The physician wrote its name: the request is the justification, and any cited fact is kept.
      seen.add(item.id);
      lines.push({ item, basis: "requested", requestedText: asked, reason, evidenceIds });
      continue;
    }
    // Not asked for by name: only a case-based request may propose it, and only with a cited chart fact.
    if (parsed.mode !== "case_based" || !evidenceIds.length || (inNamedSet.size > 0 && !inNamedSet.has(item.id))) { rejected++; continue; }
    seen.add(item.id);
    lines.push({ item, basis: "proposed", reason, evidenceIds });
  }
  const proposed = lines.filter((line) => line.basis === "proposed");
  // Over the cap, the earliest proposals stay; the rest are counted as dropped.
  const dropped = Math.max(0, proposed.length - MAX_PROPOSED_ORDERS);
  const kept = dropped ? lines.filter((line) => line.basis === "requested" || proposed.indexOf(line) < MAX_PROPOSED_ORDERS) : lines;
  return { mode: parsed.mode, lines: kept.slice(0, MAX_SPECIFIC_ORDERS), unmatched, rejected: rejected + dropped };
}
