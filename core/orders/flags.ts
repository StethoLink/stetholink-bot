import type { ClinicalFact, InteractionRule, KnownClinicalFact, OrderCatalog, OrderCatalogItem, OrderFlag, OrderLineStatus } from "@/shared/contracts";
import { mentionsTerm } from "./text";

/** An order already drafted or approved for this encounter, by its catalog id. */
export interface ExistingOrder { catalogItemId: string; status: OrderLineStatus }
export interface FlagContext {
  catalog: OrderCatalog;
  /** Every fact of the chart, known and unknown. */
  facts: readonly ClinicalFact[];
  existing: readonly ExistingOrder[];
}

const known = (fact: ClinicalFact): fact is KnownClinicalFact => fact.status === "known";
const factText = (fact: KnownClinicalFact) => `${fact.label} ${typeof fact.value === "string" ? fact.value : ""}`;

/** What a physician must acknowledge, with a reason, before approving: an allergy, or a major interaction. */
export function requiresOverride(flag: Pick<OrderFlag, "kind" | "severity">): boolean {
  return flag.kind === "allergy" || (flag.kind === "interaction" && flag.severity === "major");
}

/**
 * The safety check of one order against the chart, the other orders in the draft and the orders already in this
 * encounter. It uses only the chart's facts and the hospital's own catalog (allergy words, medication names, interaction
 * rules): StethoLink adds no clinical knowledge of its own. Where the chart does not let it check, the flag says so
 * instead of staying silent.
 */
export function flagsFor(item: OrderCatalogItem, others: readonly OrderCatalogItem[], context: FlagContext): OrderFlag[] {
  const flags: OrderFlag[] = [];
  const push = (flag: OrderFlag) => { if (!flags.some((entry) => entry.kind === flag.kind && entry.text === flag.text)) flags.push(flag); };
  const allergyFacts = context.facts.filter((fact) => fact.category === "allergy");
  const knownAllergies = allergyFacts.filter(known);
  const medicationFacts = context.facts.filter((fact) => fact.category === "medication");
  const activeMedications = medicationFacts.filter(known);

  // Allergy: the order's own words against every documented allergy.
  const allergyTerms = [...item.allergyTerms, ...(item.kind === "medication" ? item.matchTerms : [])];
  if (allergyTerms.length) {
    for (const allergy of knownAllergies) {
      const term = allergyTerms.find((candidate) => mentionsTerm(factText(allergy), candidate));
      if (term) push({ kind: "allergy", text: `The chart documents an allergy to ${allergy.label}; this order relates to "${term}".`, evidenceIds: [allergy.id] });
    }
    if (!knownAllergies.length) push({ kind: "allergies_unchecked", text: "The chart's allergy list could not be read or holds no entry, so this order was not checked against allergies.", evidenceIds: allergyFacts.map((fact) => fact.id) });
  }

  // The same medicine already active in the chart.
  if (item.kind === "medication") {
    const names = [...item.matchTerms, item.medication?.product ?? ""].filter(Boolean);
    for (const medication of activeMedications) {
      if (names.some((name) => mentionsTerm(medication.label, name))) push({ kind: "duplicate_active", text: `The chart already lists an active medication order: ${medication.label}.`, evidenceIds: [medication.id] });
    }
  }
  // The same order already drafted or approved for this encounter.
  if (context.existing.some((entry) => entry.catalogItemId === item.id && entry.status !== "rejected")) {
    push({ kind: "duplicate_order", text: "This order is already drafted or approved for this visit.", evidenceIds: [] });
  }

  // Interactions: the hospital's rules, between this order and the active medications and the other medications in the draft.
  if (item.kind === "medication" && item.groups.length) {
    const rulesFor = (otherGroups: readonly string[]) => context.catalog.interactions.filter((rule) => matches(rule, item.groups, otherGroups));
    const catalogMedications = context.catalog.items.filter((entry) => entry.kind === "medication");
    for (const medication of activeMedications) {
      const groups = catalogMedications.filter((entry) => entry.matchTerms.some((term) => mentionsTerm(medication.label, term))).flatMap((entry) => entry.groups);
      for (const rule of rulesFor(groups)) push({ kind: "interaction", severity: rule.severity, text: `${rule.text} (active medication: ${medication.label})`, evidenceIds: [medication.id] });
    }
    for (const other of others) {
      if (other.id === item.id || other.kind !== "medication") continue;
      for (const rule of rulesFor(other.groups)) push({ kind: "interaction", severity: rule.severity, text: `${rule.text} (also in this draft: ${other.display})`, evidenceIds: [] });
    }
    const relevant = context.catalog.interactions.some((rule) => rule.groups.some((group) => item.groups.includes(group)));
    if (relevant && !activeMedications.length) {
      push({ kind: "interactions_unchecked", text: "The chart's active medications could not be read or are not recorded, so interactions were not checked.", evidenceIds: medicationFacts.map((fact) => fact.id) });
    }
  }
  return flags;
}

function matches(rule: InteractionRule, mine: readonly string[], theirs: readonly string[]) {
  const [a, b] = rule.groups;
  return (mine.includes(a) && theirs.includes(b)) || (mine.includes(b) && theirs.includes(a));
}
