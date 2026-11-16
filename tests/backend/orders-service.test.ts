import { describe, expect, it, vi } from "vitest";
import type { ClinicianContext } from "@/core/auth/clinician";
import type { ModelProvider, ModelRequest, ModelResult } from "@/core/agent/providers/types";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { ORDERS_PROMPT_VERSION } from "@/core/orders/authoring";
import { requiresOverride } from "@/core/orders/flags";
import { createOrderService } from "@/core/orders/service";
import type { OrderDraft, OrderNoMatch } from "@/shared/contracts";
import { orderDraftSchema } from "@/shared/schemas";
import { fictionalIdentity } from "@/tests/fixtures/identities";
import { ORDER_CATALOG, ORDER_FACTS, knownFact, memoryOrderRepository, orderChart } from "@/tests/fixtures/orders";
import { deidentified } from "@/tests/helpers/privacy";

// A scripted model stands in for the real one: nothing here calls a model. The service, the catalog, the chart and the
// de-identification layer are the product's own.
const physician: ClinicianContext = {
  clinicianId: "55555555-5555-4555-8555-555555555555", tenantId: "fictional-hospital", roles: ["physician"], scopes: ["chart:read", "order:draft", "order:approve"],
  patientId: "fic-pt-1", encounterId: "fic-enc-1", expiresAt: Date.now() + 600_000, authorization: "active", dataClassification: "live",
};
const nurse: ClinicianContext = { ...physician, clinicianId: "66666666-6666-4666-8666-666666666666", roles: ["clinician"], scopes: ["chart:read", "order:draft"] };
const line = (itemId: string, over: object = {}) => ({ itemId, requestedText: "", reason: "A fictional reason.", evidenceIds: [], ...over });
const answer = (mode: string, items: object[], unmatched: string[] = []) => JSON.stringify({ mode, items, unmatched });

function scripted(...texts: string[]): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const queue = [...texts];
  return {
    name: "scripted", requests,
    generate: vi.fn(async (request: ModelRequest): Promise<ModelResult> => {
      requests.push(request);
      return { text: queue.length > 1 ? queue.shift()! : queue[0], provider: "scripted", model: "scripted-1" };
    }),
  };
}
function setup(provider: ModelProvider, options: { facts?: typeof ORDER_FACTS; existing?: Parameters<typeof memoryOrderRepository>[0]; catalog?: typeof ORDER_CATALOG } = {}) {
  const repository = memoryOrderRepository(options.existing);
  const chart = orderChart(options.facts);
  const service = createOrderService({ repository, provider, safety: clinicalSafetyGuard, adapter: chart.adapter, dataClassification: "live", catalog: options.catalog ?? ORDER_CATALOG });
  return { repository, service };
}
const draftOf = (result: OrderDraft | OrderNoMatch): OrderDraft => {
  if ("outcome" in result) throw new Error(`Expected a draft, got ${result.outcome}`);
  return result;
};
let keyCounter = 0;
const ask = (request: string) => ({ request, idempotencyKey: `key-${++keyCounter}` });

describe("drafting exactly the orders the physician asks for", () => {
  it("drafts the requested orders from the catalog, copies the code from it, and leaves every line pending", async () => {
    const model = scripted(answer("specific", [line("lab-cbc", { requestedText: "CBC" }), line("img-cxr", { requestedText: "chest x-ray" })]));
    const { service, repository } = setup(model);
    const draft = draftOf(await service.create(ask("Prepare a CBC and a chest X-ray"), physician));
    expect(draft.mode).toBe("specific");
    expect(draft.lines.map((entry) => [entry.catalogItemId, entry.kind, entry.basis, entry.status])).toEqual([["lab-cbc", "lab", "requested", "pending"], ["img-cxr", "imaging", "requested", "pending"]]);
    // The code comes from the hospital's catalog, whatever the model said.
    expect(draft.lines.map((entry) => entry.code)).toEqual([{ system: "urn:test", code: "CBC-1" }, { system: "urn:test", code: "CXR-2" }]);
    expect(draft.catalogVersion).toBe("test-1");
    expect(draft.provenance).toMatchObject({ provider: "scripted", model: "scripted-1", promptVersion: ORDERS_PROMPT_VERSION, dataClassification: "live", rejectedLines: 0 });
    // Nothing is approved, signed or sent: no line has a decision, and the stored draft is the one returned.
    expect(draft.lines.every((entry) => entry.status === "pending" && !entry.decidedBy && !entry.decidedAt && !entry.acknowledged)).toBe(true);
    expect(repository.drafts).toHaveLength(1);
    expect(orderDraftSchema.safeParse(repository.drafts[0]).success).toBe(true);
    expect(model.generate).toHaveBeenCalledTimes(1);
  });

  it("drafts the Arabic names the physician writes", async () => {
    const { service } = setup(scripted(answer("specific", [line("lab-cbc"), line("img-cxr")])));
    const draft = draftOf(await service.create(ask("جهّز عد دم كامل وأشعة صدر"), physician));
    expect(draft.lines.map((entry) => entry.catalogItemId)).toEqual(["lab-cbc", "img-cxr"]);
  });
});

describe("only the hospital's catalog can become an order", () => {
  it("drops an order the catalog does not hold, and an order a specific request did not name", async () => {
    const model = scripted(answer("specific", [line("lab-cbc", { requestedText: "CBC" }), line("med-made-up"), line("lab-lipids", { reason: "Hypertension.", evidenceIds: ["problem-1"] })]));
    const { service, repository } = setup(model);
    const draft = draftOf(await service.create(ask("Prepare a CBC"), physician));
    expect(draft.lines.map((entry) => entry.catalogItemId)).toEqual(["lab-cbc"]);
    expect(draft.provenance.rejectedLines).toBe(2);
    expect(repository.drafts[0].lines.map((entry) => entry.catalogItemId)).toEqual(["lab-cbc"]);
  });

  it("never lets the model write a code, a product or a dose: an answer with one is refused and asked for again, then refused", async () => {
    const withDose = JSON.stringify({ mode: "specific", unmatched: [], items: [{ ...line("med-amox"), dose: "5 g", product: "Something else" }] });
    const model = scripted(withDose);
    const { service, repository } = setup(model);
    await expect(service.create(ask("amoxicillin"), physician)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(model.generate).toHaveBeenCalledTimes(2);
    expect(repository.drafts).toHaveLength(0);
    // A good second answer is used: the first one is never patched by hand.
    const second = scripted("not json", answer("specific", [line("med-amox", { requestedText: "amoxicillin" })]));
    const { service: again } = setup(second, { facts: ORDER_FACTS.filter((fact) => fact.category !== "allergy").concat(knownFact("nka", "allergy", "No known allergy")) });
    const draft = draftOf(await again.create(ask("amoxicillin"), physician));
    expect(second.generate).toHaveBeenCalledTimes(2);
    // The medication is the catalog's product at the catalog's dose.
    expect(draft.lines[0].medication).toEqual({ product: "Amoxicillin", dose: "500 mg", route: "oral", frequency: "every 8 hours", duration: "7 days" });
  });

  it("answers no_match and stores nothing when the request matches nothing", async () => {
    const { service, repository } = setup(scripted(answer("unclear", [], ["an MRI of the knee"])));
    const result = await service.create(ask("an MRI of the knee"), physician);
    expect(result).toEqual({ outcome: "no_match", request: "an MRI of the knee", unmatched: ["an MRI of the knee"], rejectedLines: 0 });
    expect(repository.drafts).toHaveLength(0);
    // Every order the model named was dropped: nothing is drafted either.
    const { service: invented } = setup(scripted(answer("specific", [line("med-made-up")])));
    expect(await invented.create(ask("something"), physician)).toMatchObject({ outcome: "no_match", rejectedLines: 1 });
  });

  it("keeps the phrases the catalog could not match beside the orders it could", async () => {
    const { service } = setup(scripted(answer("specific", [line("lab-cbc", { requestedText: "CBC" })], ["a knee MRI"])));
    const draft = draftOf(await service.create(ask("Prepare a CBC and a knee MRI"), physician));
    expect(draft.unmatched).toEqual(["a knee MRI"]);
  });
});

describe("proposing the orders of a case, grounded in the chart", () => {
  it("proposes only orders with a cited, documented chart fact and stores the facts it cites", async () => {
    const model = scripted(answer("case_based", [
      line("lab-trop", { reason: "Chest pain of two hours.", evidenceIds: ["symptom-1"] }),
      line("img-cxr", { reason: "Chest pain.", evidenceIds: [] }),                              // no citation: dropped
      line("lab-cbc", { reason: "Baseline.", evidenceIds: ["lab-none"] }),                       // cites an unknown fact: dropped
      line("nur-obs", { reason: "Chest pain.", evidenceIds: ["symptom-1", "invented-fact"] }),    // the invented id is removed
    ]));
    const { service } = setup(model);
    const draft = draftOf(await service.create(ask("Prepare the basic orders for this case"), physician));
    expect(draft.mode).toBe("case_based");
    expect(draft.lines.map((entry) => [entry.catalogItemId, entry.basis, entry.evidenceIds])).toEqual([["lab-trop", "proposed", ["symptom-1"]], ["nur-obs", "proposed", ["symptom-1"]]]);
    expect(draft.provenance.rejectedLines).toBe(2);
    // Every citation resolves to a fact stored with the draft, and each stored fact is the chart's own.
    const stored = new Map(draft.clinicalFacts.map((fact) => [fact.id, fact]));
    for (const entry of draft.lines) for (const id of entry.evidenceIds) expect(stored.get(id)).toEqual(ORDER_FACTS.find((fact) => fact.id === id));
    expect(draft.clinicalFacts.map((fact) => fact.id)).toEqual(["symptom-1"]);
    // What the chart did not give is carried for the physician.
    expect(draft.missingInformation.map((fact) => fact.id)).toEqual(["lab-none"]);
  });

  it("limits a case-based request to the order set it names", async () => {
    const { service } = setup(scripted(answer("case_based", [line("lab-trop", { evidenceIds: ["symptom-1"] }), line("lab-lipids", { reason: "Hypertension.", evidenceIds: ["problem-1"] })])));
    const draft = draftOf(await service.create(ask("Prepare the basic orders for this case"), physician));
    expect(draft.lines.map((entry) => entry.catalogItemId)).toEqual(["lab-trop"]);
  });
});

describe("flags found in the chart", () => {
  it("flags an order related to a documented allergy, citing the allergy, and asks for an override", async () => {
    const { service } = setup(scripted(answer("specific", [line("med-amox", { requestedText: "amoxicillin" }), line("lab-cbc", { requestedText: "CBC" })])));
    const draft = draftOf(await service.create(ask("Prepare amoxicillin and a CBC"), physician));
    const amoxicillin = draft.lines.find((entry) => entry.catalogItemId === "med-amox")!;
    expect(amoxicillin.flags).toEqual([expect.objectContaining({ kind: "allergy", evidenceIds: ["allergy-1"] })]);
    expect(requiresOverride(amoxicillin.flags[0])).toBe(true);
    expect(draft.lines.find((entry) => entry.catalogItemId === "lab-cbc")!.flags).toEqual([]);
    // The allergy is stored with the draft, so the physician reads it beside the order.
    expect(draft.clinicalFacts.map((fact) => fact.id)).toContain("allergy-1");
  });

  it("flags the same medicine already active, an interaction with the chart's medication, and an order already in this visit", async () => {
    const { service } = setup(scripted(answer("specific", [line("med-warf", { requestedText: "warfarin" }), line("med-ibu", { requestedText: "ibuprofen" }), line("lab-cbc", { requestedText: "CBC" })])),
      { existing: [{ catalogItemId: "lab-cbc", status: "approved" }] });
    const draft = draftOf(await service.create(ask("Prepare warfarin, ibuprofen and a CBC"), physician));
    const kinds = (id: string) => draft.lines.find((entry) => entry.catalogItemId === id)!.flags.map((flag) => flag.kind);
    expect(kinds("med-warf")).toContain("duplicate_active");
    expect(kinds("med-ibu")).toContain("interaction");
    expect(kinds("lab-cbc")).toEqual(["duplicate_order"]);
  });

  it("says so when the allergy list could not be read, instead of staying silent", async () => {
    const facts = ORDER_FACTS.filter((fact) => fact.category !== "allergy");
    const { service } = setup(scripted(answer("specific", [line("med-amox", { requestedText: "amoxicillin" })])), { facts });
    const draft = draftOf(await service.create(ask("Prepare amoxicillin"), physician));
    expect(draft.lines[0].flags.map((flag) => flag.kind)).toEqual(["allergies_unchecked"]);
  });

  it("sees an order drafted earlier in the same visit as a duplicate", async () => {
    const model = scripted(answer("specific", [line("lab-cbc", { requestedText: "CBC" })]));
    const { service } = setup(model);
    draftOf(await service.create(ask("Prepare a CBC"), physician));
    const second = draftOf(await service.create(ask("Prepare a CBC again"), physician));
    expect(second.lines[0].flags.map((flag) => flag.kind)).toEqual(["duplicate_order"]);
  });
});

describe("a retry does not draft twice", () => {
  it("returns the stored draft for the same key and request without asking the model again, and refuses the key for another request", async () => {
    const model = scripted(answer("specific", [line("lab-cbc", { requestedText: "CBC" })]));
    const { service, repository } = setup(model);
    const input = { request: "Prepare a CBC", idempotencyKey: "retry-key" };
    const first = draftOf(await service.create(input, physician));
    const again = draftOf(await service.create(input, physician));
    expect(again).toEqual(first);
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(repository.drafts).toHaveLength(1);
    await expect(service.create({ request: "Prepare a lipid panel", idempotencyKey: "retry-key" }, physician)).rejects.toMatchObject({ code: "conflict" });
    expect(model.generate).toHaveBeenCalledTimes(1);
  });
});

describe("who may draft, and what leaves for the model", () => {
  it("lets a non-physician draft, and refuses a session without the permission, without a visit, expired, or of another classification", async () => {
    const { service } = setup(scripted(answer("specific", [line("lab-cbc", { requestedText: "CBC" })])));
    await expect(service.create(ask("Prepare a CBC"), nurse)).resolves.toMatchObject({ lines: [{ catalogItemId: "lab-cbc", status: "pending" }] });
    for (const actor of [
      { ...physician, scopes: ["chart:read"] }, { ...physician, encounterId: undefined }, { ...physician, expiresAt: Date.now() - 1 },
      { ...physician, dataClassification: "synthetic" as const }, { ...physician, authorization: "expired" as unknown as "active" },
    ]) {
      await expect(service.create(ask("Prepare a CBC"), actor)).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.list(actor)).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.get("id", actor)).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("refuses a request that is empty or too long, and never reads the chart for it", async () => {
    const model = scripted(answer("specific", []));
    const { service } = setup(model);
    for (const request of ["", " ", "x".repeat(2001)]) await expect(service.create({ request, idempotencyKey: "k" }, physician)).rejects.toMatchObject({ code: "invalid_request" });
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("withholds a draft whose text the safety check blocks", async () => {
    const model = scripted(answer("specific", [line("lab-cbc", { requestedText: "CBC", reason: "<script>alert(1)</script> CBC" })]));
    const { service, repository } = setup(model);
    await expect(service.create(ask("Prepare a CBC"), physician)).rejects.toMatchObject({ code: "safety_blocked" });
    expect(repository.drafts).toHaveLength(0);
  });

  it("sends the model the request, the facts and the catalog's names only, de-identified, and restores what comes back", async () => {
    const REQUEST = "Prepare a CBC for Mohammed Al-Otaibi (MRN-00482913)";
    /** A model that quotes the physician's request back as the reason, so what it was sent comes back to the service. */
    const quoting = (requests: ModelRequest[]): ModelProvider => ({
      name: "quoting",
      async generate(request) {
        requests.push(request);
        const received = (JSON.parse(request.messages[0].content) as { request: string }).request;
        return { text: answer("specific", [line("lab-cbc", { requestedText: "CBC", reason: `Asked for: ${received}` })]), provider: "quoting", model: "quoting-1" };
      },
    });
    const run = async (provider: (requests: ModelRequest[]) => ModelProvider, wrap: (inner: ModelProvider) => ModelProvider) => {
      const requests: ModelRequest[] = [];
      const service = createOrderService({ repository: memoryOrderRepository(), provider: wrap(provider(requests)), safety: clinicalSafetyGuard, adapter: orderChart().adapter, dataClassification: "live", catalog: ORDER_CATALOG });
      return { draft: draftOf(await service.create(ask(REQUEST), physician)), requests };
    };
    // Control: without the layer the physician's words, with the patient's name and number, would reach the model as typed.
    const bare = await run(quoting, (inner) => inner);
    expect(JSON.stringify(bare.requests)).toContain("Mohammed Al-Otaibi");

    const { draft, requests } = await run(quoting, (inner) => deidentified(inner, fictionalIdentity));
    expect(draft.request).toBe(REQUEST);
    const sent = JSON.stringify(requests);
    for (const identifier of ["Mohammed", "Otaibi", "00482913", "Faisal", "Fictional-Example", "fic-pt-1", "fic-enc-1", "1967-04-02"]) expect(sent, identifier).not.toContain(identifier);
    // The catalog's codes, products and doses are not part of what the model sees.
    for (const secret of ["CBC-1", "CXR-2", "urn:test", "every 8 hours", "\"dose\"", "\"product\"", "allergyTerms", "matchTerms"]) expect(sent, secret).not.toContain(secret);
    expect(requests[0].pseudonymized).toBe(true);
    expect(requests[0].structuredOutput?.name).toBe("order_drafting");
    // The model quoted its stand-in; the physician reads their own words and the real name again.
    expect(draft.lines[0].reason).toBe(`Asked for: ${REQUEST}`);
  });
});

describe("reading drafts", () => {
  it("lists and reads the drafts of the visit", async () => {
    const { service } = setup(scripted(answer("specific", [line("lab-cbc", { requestedText: "CBC" }), line("img-cxr", { requestedText: "chest x-ray" })])));
    const draft = draftOf(await service.create(ask("Prepare a CBC and a chest X-ray"), physician));
    expect(await service.list(physician)).toEqual([expect.objectContaining({ id: draft.id, lines: 2, pending: 2, approved: 0, rejected: 0, version: 1 })]);
    expect(await service.get(draft.id, physician)).toEqual(draft);
    expect(await service.get("missing", physician)).toBeNull();
  });
});
