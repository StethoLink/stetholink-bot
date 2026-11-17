import { describe, expect, it, vi } from "vitest";
import type { ClinicianContext } from "@/core/auth/clinician";
import { createOpenAIProvider } from "@/core/agent/providers/openai-provider";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { requiredAcknowledgements } from "@/core/orders/flags";
import { createOrderService } from "@/core/orders/service";
import type { ChartIdentity } from "@/core/privacy/ports";
import type { OrderDraft, OrderNoMatch } from "@/shared/contracts";
import { ORDER_CATALOG, ORDER_FACTS, memoryOrderRepository, orderChart } from "../fixtures/orders";
import { deidentified } from "../helpers/privacy";

vi.mock("server-only", () => ({}));

/**
 * Opt-in: a real model drafting orders from the FICTIONAL chart and the FICTIONAL catalog of tests/fixtures, through the de-identification layer.
 *   RUN_ORDERS_LIVE_EVAL=1 OPENAI_API_KEY=... (NODE_USE_ENV_PROXY=1 and NODE_EXTRA_CA_CERTS behind a proxy)
 * It shows what the scripted tests cannot: that a real model answers the order schema, chooses by catalog id from the physician's own words in English and
 * Arabic, proposes for a case only what the chart supports, and that what leaves for the model holds no identifier, code, product or dose.
 * It judges no clinical quality (the catalog is invented) and is not run by `npm run check`.
 */
const enabled = process.env.RUN_ORDERS_LIVE_EVAL === "1" && Boolean(process.env.OPENAI_API_KEY);

const physician: ClinicianContext = {
  clinicianId: "55555555-5555-4555-8555-555555555555", tenantId: "fictional-hospital", roles: ["physician"], scopes: ["chart:read", "order:draft", "order:approve"],
  patientId: "fic-pt-1", encounterId: "fic-enc-1", expiresAt: Date.now() + 600_000, authorization: "active", dataClassification: "live",
};
// The chart's own identifiers: if any of them reached the model, the layer or the order input would be at fault.
const identity: ChartIdentity = {
  anchorDate: "2026-03-10T07:30:00.000Z",
  people: [{ role: "patient", sex: "male", names: [{ given: ["Faisal"], family: "Fictional-Example" }] }],
  identifiers: ["fic-pt-1", "fic-enc-1"],
};
// An order's display name may hold its strength ("Amoxicillin 500 mg capsule"): that is the name the physician sees. The fields of the order are what must not leave.
const FORBIDDEN = ["Faisal", "Fictional-Example", "fic-pt-1", "fic-enc-1", "CBC-1", "CXR-2", "urn:test", "every 8 hours", "7 days", "\"dose\"", "\"product\"", "\"route\"", "\"frequency\"", "allergyTerms", "matchTerms", "\"groups\""];

describe.skipIf(!enabled)("order drafting (live model, fictional chart and catalog)", () => {
  const bodies: string[] = [];
  const capture: typeof fetch = (url, init) => { bodies.push(String(init?.body)); return fetch(url, init); };
  // Built on first use: a skipped suite still runs its body, and nothing here may need a key then.
  let built: ReturnType<typeof createOrderService> | undefined;
  const service = () => built ??= createOrderService({
    repository: memoryOrderRepository(), safety: clinicalSafetyGuard, adapter: orderChart().adapter, dataClassification: "live", catalog: ORDER_CATALOG,
    // The fictional chart is read through a FHIR-shaped adapter, which is live data to the product, so the client is told the test approves it. List prices only bound this test's spend.
    provider: deidentified(createOpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY, model: process.env.ORDERS_LIVE_MODEL ?? "gpt-5", timeoutMs: 28_000, maxRetries: 0, maxInputTokens: 24_000, maxOutputTokens: 4000, maxCostUsd: 0.25,
      reasoningEffort: "low", inputUsdPerMillion: 1.25, outputUsdPerMillion: 10, liveDataApproved: true,
    }, capture), identity),
  });
  let counter = 0;
  const ask = async (request: string): Promise<OrderDraft | OrderNoMatch> => service().create({ request, idempotencyKey: `orders-live-${++counter}` }, physician);
  const draftOf = (result: OrderDraft | OrderNoMatch): OrderDraft => {
    if ("outcome" in result) throw new Error(`Expected a draft, got ${JSON.stringify(result)}`);
    return result;
  };
  const ids = (draft: OrderDraft) => draft.lines.map((line) => line.catalogItemId).sort();

  it("drafts exactly the orders the physician names, in English", async () => {
    const draft = draftOf(await ask("Prepare a CBC and a chest X-ray"));
    console.info(JSON.stringify({ english: { mode: draft.mode, lines: draft.lines.map((line) => [line.catalogItemId, line.basis, line.reason]), rejected: draft.provenance.rejectedLines } }));
    expect(draft.mode).toBe("specific");
    expect(ids(draft)).toEqual(["img-cxr", "lab-cbc"]);
    // The code and the dose are the catalog's, whatever the model said; every line waits for the physician.
    expect(draft.lines.map((line) => line.code?.code).sort()).toEqual(["CBC-1", "CXR-2"]);
    expect(draft.lines.every((line) => line.basis === "requested" && line.status === "pending" && !line.decidedBy)).toBe(true);
  }, 60_000);

  it("drafts what is written in Arabic, and flags the medicine the chart's allergy relates to", async () => {
    const draft = draftOf(await ask("جهّز عد دم كامل و amoxicillin"));
    console.info(JSON.stringify({ arabic: { lines: draft.lines.map((line) => [line.catalogItemId, line.flags.map((flag) => flag.kind)]) } }));
    expect(ids(draft)).toEqual(["lab-cbc", "med-amox"]);
    const amoxicillin = draft.lines.find((line) => line.catalogItemId === "med-amox")!;
    expect(amoxicillin.flags).toEqual([expect.objectContaining({ kind: "allergy", evidenceIds: ["allergy-1"] })]);
    expect(requiredAcknowledgements(amoxicillin.flags)).toEqual(["allergy"]);
    expect(amoxicillin.medication).toEqual({ product: "Amoxicillin", dose: "500 mg", route: "oral", frequency: "every 8 hours", duration: "7 days" });
  }, 60_000);

  it("proposes for a case only orders of the named set, each resting on a documented chart fact", async () => {
    const draft = draftOf(await ask("Prepare the basic orders for this case"));
    console.info(JSON.stringify({ case: { lines: draft.lines.map((line) => [line.catalogItemId, line.evidenceIds, line.reason]), rejected: draft.provenance.rejectedLines } }));
    expect(draft.mode).toBe("case_based");
    expect(draft.lines.length).toBeGreaterThan(0);
    const set = new Set(ORDER_CATALOG.sets[0].itemIds);
    const known = new Set(ORDER_FACTS.filter((fact) => fact.status === "known").map((fact) => fact.id));
    for (const line of draft.lines) {
      expect(set.has(line.catalogItemId), line.catalogItemId).toBe(true);
      expect(line.basis).toBe("proposed");
      expect(line.evidenceIds.length).toBeGreaterThan(0);
      expect(line.evidenceIds.every((id) => known.has(id)), line.catalogItemId).toBe(true);
    }
    // Every cited fact is stored with the draft, so the physician reads it beside the order.
    const stored = new Set(draft.clinicalFacts.map((fact) => fact.id));
    expect(draft.lines.flatMap((line) => line.evidenceIds).every((id) => stored.has(id))).toBe(true);
  }, 60_000);

  it("drafts nothing for what the catalog does not hold, and says which words matched nothing", async () => {
    const result = await ask("an MRI of the knee");
    console.info(JSON.stringify({ noMatch: result }));
    expect("outcome" in result && result.outcome).toBe("no_match");
  }, 60_000);

  it("sent the model no name, identifier, code, product or dose", () => {
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    for (const body of bodies) for (const secret of FORBIDDEN) expect(body, secret).not.toContain(secret);
  });
});
