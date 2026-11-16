import { describe, expect, it } from "vitest";
import { MAX_PROPOSED_ORDERS, buildOrderInput, validateOrders, type OrderAuthoringContext } from "@/core/orders/authoring";
import { flagsFor, requiresOverride } from "@/core/orders/flags";
import { containsPhrase, mentionsTerm, normalize } from "@/core/orders/text";
import { orderCatalogSchema } from "@/shared/schemas";
import type { ClinicalFact, KnownClinicalFact, OrderCatalog, OrderCatalogItem } from "@/shared/contracts";

/** Every item, person and fact here is fictional. The catalog is a test catalog, not clinical guidance. */
const item = (over: Partial<OrderCatalogItem> & Pick<OrderCatalogItem, "id" | "kind" | "display">): OrderCatalogItem =>
  ({ synonyms: [], matchTerms: [], groups: [], allergyTerms: [], ...over });
const CATALOG: OrderCatalog = {
  version: "test-1",
  items: [
    item({ id: "lab-cbc", kind: "lab", display: "Complete blood count", synonyms: ["CBC", "full blood count", "عد دم كامل"], code: { system: "urn:test", code: "CBC-1" } }),
    item({ id: "img-cxr", kind: "imaging", display: "Chest X-ray, two views", synonyms: ["chest x-ray", "CXR", "أشعة صدر"], code: { system: "urn:test", code: "CXR-2" } }),
    item({ id: "lab-trop", kind: "lab", display: "High-sensitivity troponin", synonyms: ["troponin"] }),
    item({ id: "lab-lipids", kind: "lab", display: "Lipid panel", synonyms: ["lipids"] }),
    item({ id: "nur-obs", kind: "nursing", display: "Vital signs every 4 hours", synonyms: ["observations q4h"] }),
    item({ id: "med-amox", kind: "medication", display: "Amoxicillin 500 mg capsule", synonyms: ["amoxicillin"], matchTerms: ["amoxicillin"], allergyTerms: ["penicillin"],
      medication: { product: "Amoxicillin", dose: "500 mg", route: "oral", frequency: "every 8 hours", duration: "7 days" } }),
    item({ id: "med-ibu", kind: "medication", display: "Ibuprofen 400 mg tablet", synonyms: ["ibuprofen"], matchTerms: ["ibuprofen"], groups: ["nsaid"],
      medication: { product: "Ibuprofen", dose: "400 mg", route: "oral", frequency: "every 8 hours" } }),
    item({ id: "med-warf", kind: "medication", display: "Warfarin 5 mg tablet", synonyms: ["warfarin"], matchTerms: ["warfarin"], groups: ["anticoagulant"],
      medication: { product: "Warfarin", dose: "5 mg", route: "oral", frequency: "once daily" } }),
  ],
  sets: [{ id: "set-chest", name: "Chest pain basics", synonyms: ["basic orders", "الطلبات الأساسية"], itemIds: ["lab-cbc", "img-cxr", "lab-trop", "nur-obs"] }],
  interactions: [{ groups: ["nsaid", "anticoagulant"], severity: "major", text: "An NSAID with an anticoagulant raises the risk of bleeding." }],
};
const known = (id: string, category: ClinicalFact["category"], label: string, value: KnownClinicalFact["value"] = true): KnownClinicalFact =>
  ({ id, category, label, status: "known", value, source: { type: "fhir", reference: `R/${id}` }, timestamp: "2026-01-15T10:00:00.000Z" });
const unknown = (id: string, category: ClinicalFact["category"], label: string): ClinicalFact =>
  ({ id, category, label, status: "unknown", reason: "not_recorded", source: { type: "fhir", reference: `R/${id}` }, timestamp: "2026-01-15T10:00:00.000Z" });

const FACTS: ClinicalFact[] = [
  known("symptom-1", "symptom", "Chest pain", "two hours, pressing"),
  known("problem-1", "problem", "Essential hypertension"),
  known("allergy-1", "allergy", "Penicillins", "Reaction: urticaria"),
  known("med-1", "medication", "Warfarin 5 mg oral tablet", "5 mg once daily"),
  unknown("lab-none", "investigation", "Laboratory results in the last 365 days"),
];
const context = (request: string, over: Partial<OrderAuthoringContext> = {}): OrderAuthoringContext => ({
  request, demographics: { age: "58 years", sex: "female" }, reasonForVisit: "Chest pain", facts: FACTS,
  eligibleFacts: FACTS.filter((fact): fact is KnownClinicalFact => fact.status === "known"), catalog: CATALOG, ...over,
});
const reply = (mode: string, items: object[], unmatched: string[] = []) => JSON.stringify({ mode, items, unmatched });
const line = (itemId: string, over: object = {}) => ({ itemId, requestedText: "", reason: "Requested.", evidenceIds: [], ...over });

describe("matching the physician's words", () => {
  it("ignores case, punctuation, accents and Arabic spelling variants, and matches whole words only", () => {
    expect(normalize("Chest X-ray, 2 views!")).toBe("chest x ray 2 views");
    expect(normalize("أَشِعَّة الصَّدْر")).toBe(normalize("اشعه الصدر"));
    expect(containsPhrase("Please prepare a CBC and a chest x-ray", "chest X-ray")).toBe(true);
    expect(containsPhrase("Please prepare a CBCX", "CBC")).toBe(false);
    expect(containsPhrase("جهّز عد دم كامل وأشعة صدر", "عد دم كامل")).toBe(true);
    expect(mentionsTerm("Penicillins", "penicillin")).toBe(true);
    expect(mentionsTerm("Penicillin V potassium 250 mg", "penicillin")).toBe(true);
    expect(mentionsTerm("Sulfa", "penicillin")).toBe(false);
  });
});

describe("the order catalog", () => {
  it("accepts a well-formed catalog and refuses what would let an order carry anything but the catalog's own words", () => {
    expect(orderCatalogSchema.safeParse(CATALOG).success).toBe(true);
    const bad = (change: (catalog: OrderCatalog) => void) => { const copy = structuredClone(CATALOG); change(copy); return orderCatalogSchema.safeParse(copy).success; };
    expect(bad((c) => { delete c.items.find((entry) => entry.id === "med-amox")!.medication; })).toBe(false); // a medication without product and dose
    expect(bad((c) => { c.items.find((entry) => entry.id === "lab-cbc")!.medication = { product: "x", dose: "1", route: "o", frequency: "d" }; })).toBe(false); // a dose on a lab
    expect(bad((c) => { c.items[1].id = c.items[0].id; })).toBe(false); // duplicate ids
    expect(bad((c) => { c.sets[0].itemIds.push("not-in-catalog"); })).toBe(false); // a set naming an unknown order
    expect(bad((c) => { (c.items[0] as unknown as Record<string, unknown>).price = 10; })).toBe(false); // no extra fields
  });
});

describe("what the model is allowed to turn into orders", () => {
  it("never reaches the model with a code, a dose or a product", () => {
    const input = buildOrderInput(context("prepare a CBC"));
    expect(input).toContain("lab-cbc");
    // The catalog's display name may carry the strength ("Amoxicillin 500 mg capsule"): it is how the model tells two entries apart.
    // What it never receives is the structured product, dose, route, frequency, duration or code, which are copied from the catalog afterwards.
    for (const secret of ["CBC-1", "CXR-2", "urn:test", "every 8 hours", "7 days", "allergyTerms", "matchTerms", "nsaid", "anticoagulant", "\"product\"", "\"route\"", "\"dose\"", "\"frequency\""]) expect(input, secret).not.toContain(secret);
  });

  it("drafts exactly the orders a specific request names, and drops whatever else the model adds", () => {
    const result = validateOrders(reply("specific", [
      line("lab-cbc", { requestedText: "CBC" }), line("img-cxr", { requestedText: "chest x-ray" }),
      line("lab-lipids", { reason: "Reasonable for hypertension.", evidenceIds: ["problem-1"] }),
    ]), context("Prepare a CBC and a chest X-ray"));
    expect(result.mode).toBe("specific");
    expect(result.lines.map((entry) => entry.item.id)).toEqual(["lab-cbc", "img-cxr"]);
    expect(result.lines.every((entry) => entry.basis === "requested")).toBe(true);
    expect(result.rejected).toBe(1);
  });

  it("takes an order only from the catalog: an invented id is dropped, and extra fields such as a dose make the whole answer invalid", () => {
    const invented = validateOrders(reply("specific", [line("lab-cbc"), line("med-made-up")]), context("prepare a CBC"));
    expect(invented.lines.map((entry) => entry.item.id)).toEqual(["lab-cbc"]);
    expect(invented.rejected).toBe(1);
    const withDose = JSON.stringify({ mode: "specific", unmatched: [], items: [{ ...line("med-amox"), dose: "5 g" }] });
    expect(() => validateOrders(withDose, context("amoxicillin"))).toThrow(/invalid order selection/);
    expect(() => validateOrders("not json", context("amoxicillin"))).toThrow(/invalid order selection/);
  });

  it("matches the physician's Arabic names and synonyms", () => {
    const result = validateOrders(reply("specific", [line("lab-cbc"), line("img-cxr")]), context("جهّز عد دم كامل وأشعة صدر"));
    expect(result.lines.map((entry) => entry.item.id)).toEqual(["lab-cbc", "img-cxr"]);
    expect(result.lines[0].requestedText).toBeTruthy();
  });

  it("proposes orders for a case only with a cited, documented chart fact", () => {
    const result = validateOrders(reply("case_based", [
      line("lab-trop", { reason: "Chest pain of two hours.", evidenceIds: ["symptom-1"] }),
      line("img-cxr", { reason: "Chest pain.", evidenceIds: [] }),                                  // no citation
      line("lab-cbc", { reason: "Baseline.", evidenceIds: ["lab-none"] }),                            // cites an unknown fact
      line("nur-obs", { reason: "Chest pain.", evidenceIds: ["not-a-fact", "symptom-1"] }),           // one invalid id, one valid
    ]), context("prepare the orders for this case"));
    expect(result.lines.map((entry) => [entry.item.id, entry.basis, entry.evidenceIds])).toEqual([
      ["lab-trop", "proposed", ["symptom-1"]], ["nur-obs", "proposed", ["symptom-1"]],
    ]);
    expect(result.rejected).toBe(2);
  });

  it("limits a case-based request to the order set it names, and keeps what the physician also named", () => {
    const result = validateOrders(reply("case_based", [
      line("lab-trop", { reason: "Chest pain.", evidenceIds: ["symptom-1"] }),
      line("lab-lipids", { reason: "Hypertension.", evidenceIds: ["problem-1"] }),                    // not in the set
      line("lab-cbc", { requestedText: "CBC", reason: "Asked for.", evidenceIds: [] }),
    ]), context("prepare the basic orders for this case, and a CBC"));
    expect(result.lines.map((entry) => [entry.item.id, entry.basis])).toEqual([["lab-trop", "proposed"], ["lab-cbc", "requested"]]);
    const arabic = validateOrders(reply("case_based", [line("lab-lipids", { reason: "x", evidenceIds: ["problem-1"] })]), context("جهّز الطلبات الأساسية"));
    expect(arabic.lines).toEqual([]);
  });

  it("returns nothing for a request it cannot match, repeats an order once, and caps what it proposes", () => {
    expect(validateOrders(reply("unclear", [line("lab-cbc")], ["an MRI of the knee"]), context("an MRI of the knee"))).toMatchObject({ mode: "unclear", lines: [], unmatched: ["an MRI of the knee"] });
    expect(validateOrders(reply("specific", [line("lab-cbc"), line("lab-cbc")]), context("CBC")).lines).toHaveLength(1);
    const many = { ...CATALOG, items: [...CATALOG.items, ...Array.from({ length: 20 }, (_, index) => item({ id: `lab-x${index}`, kind: "lab" as const, display: `Extra test ${index}` }))] };
    const proposals = many.items.filter((entry) => entry.id.startsWith("lab-x")).map((entry) => line(entry.id, { reason: "Chest pain.", evidenceIds: ["symptom-1"] }));
    const capped = validateOrders(reply("case_based", proposals), context("orders for this case", { catalog: many }));
    expect(capped.lines).toHaveLength(MAX_PROPOSED_ORDERS);
    expect(capped.rejected).toBe(20 - MAX_PROPOSED_ORDERS);
  });
});

describe("the safety check of an order", () => {
  const find = (id: string) => CATALOG.items.find((entry) => entry.id === id)!;
  const ctx = (facts: ClinicalFact[] = FACTS, existing: { catalogItemId: string; status: "pending" | "approved" | "rejected" }[] = []) => ({ catalog: CATALOG, facts, existing });

  it("flags an order that relates to a documented allergy, citing it, and asks for an override", () => {
    const flags = flagsFor(find("med-amox"), [], ctx());
    expect(flags).toEqual([expect.objectContaining({ kind: "allergy", evidenceIds: ["allergy-1"] })]);
    expect(requiresOverride(flags[0])).toBe(true);
    // An order the allergy has nothing to do with is not flagged.
    expect(flagsFor(find("lab-cbc"), [], ctx())).toEqual([]);
  });

  it("says so when the allergy list could not be checked, instead of staying silent", () => {
    const facts = FACTS.filter((fact) => fact.category !== "allergy").concat(unknown("allergy-none", "allergy", "Allergies"));
    expect(flagsFor(find("med-amox"), [], ctx(facts)).map((flag) => flag.kind)).toEqual(["allergies_unchecked"]);
    // A recorded "no known allergy" is a checked chart.
    const none = FACTS.filter((fact) => fact.category !== "allergy").concat(known("nka", "allergy", "No known allergy"));
    expect(flagsFor(find("med-amox"), [], ctx(none))).toEqual([]);
  });

  it("flags the same medicine already active in the chart and an order already in this visit", () => {
    expect(flagsFor(find("med-warf"), [], ctx()).map((flag) => flag.kind)).toContain("duplicate_active");
    const again = flagsFor(find("lab-cbc"), [], ctx(FACTS, [{ catalogItemId: "lab-cbc", status: "approved" }]));
    expect(again).toEqual([expect.objectContaining({ kind: "duplicate_order" })]);
    expect(flagsFor(find("lab-cbc"), [], ctx(FACTS, [{ catalogItemId: "lab-cbc", status: "rejected" }]))).toEqual([]);
  });

  it("applies the hospital's interaction rules to the active medications and to the other orders in the draft", () => {
    const withChart = flagsFor(find("med-ibu"), [], ctx());
    expect(withChart).toEqual([expect.objectContaining({ kind: "interaction", severity: "major", evidenceIds: ["med-1"] })]);
    expect(requiresOverride(withChart[0])).toBe(true);
    const noWarfarin = FACTS.filter((fact) => fact.id !== "med-1").concat(known("med-2", "medication", "Metformin 500 mg tablet"));
    expect(flagsFor(find("med-ibu"), [], ctx(noWarfarin))).toEqual([]);
    const inDraft = flagsFor(find("med-ibu"), [find("med-warf")], ctx(noWarfarin));
    expect(inDraft).toEqual([expect.objectContaining({ kind: "interaction", evidenceIds: [] })]);
    expect(inDraft[0].text).toContain("Warfarin");
  });

  it("says so when the active medications could not be read, so no interaction check ran", () => {
    const facts = FACTS.filter((fact) => fact.category !== "medication").concat(unknown("med-none", "medication", "Active medication orders"));
    expect(flagsFor(find("med-ibu"), [], ctx(facts)).map((flag) => flag.kind)).toEqual(["interactions_unchecked"]);
  });
});
