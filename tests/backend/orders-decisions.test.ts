import { describe, expect, it, vi } from "vitest";
import type { ClinicianContext } from "@/core/auth/clinician";
import type { ModelProvider } from "@/core/agent/providers/types";
import { clinicalSafetyGuard } from "@/core/agent/safety/guard";
import { MIN_OVERRIDE_REASON } from "@/core/orders/flags";
import { createOrderService, orderCopyText, orderItemKey, orderWriteItem } from "@/core/orders/service";
import { RESOURCE_OF, type ChartWriteItem, type ClinicalWriteAdapter } from "@/core/tools/chart-writer";
import type { OrderDecisionRequest, OrderDraft, OrderLine } from "@/shared/contracts";
import { ORDER_CATALOG, memoryOrderLedger as memoryLedger, memoryOrderRepository, orderChart } from "@/tests/fixtures/orders";

// A scripted model drafts; the physician's decisions, the ledger and the EHR writer are the product's own rules around test doubles.
// The database's own enforcement of the same rules is in supabase/tests/order_decisions.sql.
const physician: ClinicianContext = {
  clinicianId: "55555555-5555-4555-8555-555555555555", tenantId: "fictional-hospital", roles: ["physician"], scopes: ["chart:read", "order:draft", "order:approve", "chart:write"],
  patientId: "fic-pt-1", encounterId: "fic-enc-1", expiresAt: Date.now() + 600_000, authorization: "active", dataClassification: "live",
};
const nurse: ClinicianContext = { ...physician, roles: ["clinician"], scopes: ["chart:read", "order:draft"] };
const REASON = "The patient tolerated it before; the benefit outweighs the risk.";
const line = (itemId: string, over: object = {}) => ({ itemId, requestedText: "", reason: "A fictional reason.", evidenceIds: [], ...over });

function model(...items: object[]): ModelProvider {
  return { name: "scripted", async generate() { return { text: JSON.stringify({ mode: "specific", items, unmatched: [] }), provider: "scripted", model: "scripted-1" }; } };
}
function writerThat(answer: (item: ChartWriteItem, call: number) => { status: "created" | "existing" | "failed" | "unsupported"; resourceId?: string; failure?: string }) {
  const items: ChartWriteItem[] = [];
  const writer: ClinicalWriteAdapter = { source: "fhir", async create(item) { items.push(item); const result = answer(item, items.length); return { ...result, resourceType: RESOURCE_OF[item.kind] }; } };
  return { writer, items };
}
const created = (_item: ChartWriteItem, call: number) => ({ status: "created" as const, resourceId: `fic-created-${call}` });

async function drafted(items: object[], options: { writer?: ClinicalWriteAdapter | null; noLedger?: boolean } = {}) {
  const repository = memoryOrderRepository();
  const memory = memoryLedger(repository);
  const service = createOrderService({
    repository, provider: model(...items), safety: clinicalSafetyGuard, adapter: orderChart().adapter, dataClassification: "live", catalog: ORDER_CATALOG,
    ...(options.noLedger ? {} : { ledger: memory.ledger }), writer: options.writer ?? null,
  });
  const result = await service.create({ request: "Prepare a CBC, a chest x-ray, amoxicillin and ibuprofen", idempotencyKey: "k-" + Math.random() }, physician);
  if ("outcome" in result) throw new Error("Expected a draft");
  return { repository, service, draft: result as OrderDraft, ...memory };
}
const all = [line("lab-cbc", { requestedText: "CBC" }), line("img-cxr", { requestedText: "chest x-ray" }), line("med-amox", { requestedText: "amoxicillin" }), line("med-ibu", { requestedText: "ibuprofen" })];
const lineOf = (draft: OrderDraft, itemId: string): OrderLine => draft.lines.find((entry) => entry.catalogItemId === itemId)!;
const decide = (draft: OrderDraft, decisions: OrderDecisionRequest["decisions"], key = "decide-" + Math.random()): OrderDecisionRequest => ({ draftId: draft.id, expectedVersion: draft.version, idempotencyKey: key, decisions });

describe("the physician decides each order", () => {
  it("approves and rejects line by line, and leaves the rest pending; nothing is written", async () => {
    const { service, draft, begun } = await drafted(all);
    const updated = await service.decide(decide(draft, [{ lineId: lineOf(draft, "lab-cbc").id, decision: "approve" }, { lineId: lineOf(draft, "img-cxr").id, decision: "reject" }]), physician);
    expect(updated.version).toBe(draft.version + 1);
    expect(updated.lines.map((entry) => [entry.catalogItemId, entry.status])).toEqual([["lab-cbc", "approved"], ["img-cxr", "rejected"], ["med-amox", "pending"], ["med-ibu", "pending"]]);
    const cbc = lineOf(updated, "lab-cbc");
    expect(cbc).toMatchObject({ decidedBy: physician.clinicianId });
    expect(cbc.decidedAt).toBeTruthy();
    expect(lineOf(updated, "med-amox")).not.toHaveProperty("decidedBy");
    expect(begun).toEqual([]);
  });

  it("is the physician's alone: a non-physician, a session without the permission, without a visit, expired or of another classification is refused, and nothing is recorded", async () => {
    const { service, draft, repository } = await drafted(all);
    const request = decide(draft, [{ lineId: draft.lines[0].id, decision: "approve" }]);
    for (const actor of [
      nurse, { ...physician, scopes: ["chart:read", "order:draft"] }, { ...physician, scopes: ["chart:read", "order:approve"] }, { ...physician, encounterId: undefined },
      { ...physician, expiresAt: Date.now() - 1 }, { ...physician, dataClassification: "synthetic" as const },
    ]) await expect(service.decide(request, actor)).rejects.toMatchObject({ code: "forbidden" });
    expect(repository.decisions).toEqual([]);
    expect(repository.drafts[0].lines.every((entry) => entry.status === "pending")).toBe(true);
  });

  it("asks for the acknowledgement and a reason before approving an allergy or a major interaction, and for nothing else", async () => {
    const { service, draft, repository } = await drafted(all);
    const amoxicillin = lineOf(draft, "med-amox");
    const ibuprofen = lineOf(draft, "med-ibu");
    expect(amoxicillin.flags.map((flag) => flag.kind)).toEqual(["allergy"]);
    expect(ibuprofen.flags).toEqual([expect.objectContaining({ kind: "interaction", severity: "major" })]);
    const refused = async (decision: OrderDecisionRequest["decisions"][number]) => { await expect(service.decide(decide(draft, [decision]), physician)).rejects.toMatchObject({ code: "invalid_request" }); };
    await refused({ lineId: amoxicillin.id, decision: "approve" });
    await refused({ lineId: amoxicillin.id, decision: "approve", acknowledged: ["allergy"] });
    await refused({ lineId: amoxicillin.id, decision: "approve", acknowledged: ["allergy"], overrideReason: "ok" });
    await refused({ lineId: amoxicillin.id, decision: "approve", acknowledged: ["allergy"], overrideReason: " ".repeat(40) });
    await refused({ lineId: amoxicillin.id, decision: "approve", acknowledged: ["interaction"], overrideReason: REASON });
    await refused({ lineId: ibuprofen.id, decision: "approve", acknowledged: ["allergy"], overrideReason: REASON });
    expect(REASON.length).toBeGreaterThanOrEqual(MIN_OVERRIDE_REASON);
    expect(repository.decisions).toEqual([]);
    // Rejecting needs nothing; approving with the flag acknowledged and a reason is accepted.
    const updated = await service.decide(decide(draft, [
      { lineId: amoxicillin.id, decision: "approve", acknowledged: ["allergy"], overrideReason: REASON }, { lineId: ibuprofen.id, decision: "reject" }]), physician);
    expect(lineOf(updated, "med-amox")).toMatchObject({ status: "approved", acknowledged: ["allergy"], overrideReason: REASON });
    expect(lineOf(updated, "med-ibu")).toMatchObject({ status: "rejected" });
    expect(lineOf(updated, "med-ibu")).not.toHaveProperty("overrideReason");
  });

  it("refuses a stale version, an order that is not in the draft, an order decided before and a malformed command; a retry returns the first result", async () => {
    const { service, draft } = await drafted(all);
    const first = lineOf(draft, "lab-cbc");
    await expect(service.decide({ ...decide(draft, [{ lineId: first.id, decision: "approve" }]), expectedVersion: 7 }, physician)).rejects.toMatchObject({ code: "conflict" });
    await expect(service.decide(decide(draft, [{ lineId: crypto.randomUUID(), decision: "approve" }]), physician)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.decide({ ...decide(draft, [{ lineId: first.id, decision: "approve" }]), draftId: crypto.randomUUID() }, physician)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.decide({ ...decide(draft, [{ lineId: first.id, decision: "approve" }]), draftId: "not-an-id" }, physician)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.decide(decide(draft, [{ lineId: first.id, decision: "approve" }, { lineId: first.id, decision: "reject" }]), physician)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.decide(decide(draft, []), physician)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.decide({ ...decide(draft, [{ lineId: first.id, decision: "approve" }]), dose: "5 g" } as never, physician)).rejects.toMatchObject({ code: "invalid_request" });
    const command = decide(draft, [{ lineId: first.id, decision: "approve" }], "same-command");
    const done = await service.decide(command, physician);
    // The retry, with the version it was sent with, is the same command: it returns the draft and decides nothing again.
    expect(await service.decide(command, physician)).toEqual(done);
    // A decided order is not decided again, by another command.
    await expect(service.decide(decide(done, [{ lineId: first.id, decision: "reject" }]), physician)).rejects.toMatchObject({ code: "conflict" });
    // The key for other decisions is refused.
    await expect(service.decide({ ...command, decisions: [{ lineId: first.id, decision: "reject" }] }, physician)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("nothing reaches the chart without a physician's approval", () => {
  it("writes nothing for pending or rejected orders, and each approved order once", async () => {
    const { writer, items } = writerThat(created);
    const { service, draft, rows, begun } = await drafted(all, { writer });
    // Everything is pending: nothing is asked of the ledger or the EHR.
    expect(await service.chart(draft.id, physician, { write: true })).toEqual([]);
    expect(items).toEqual([]);
    expect(begun).toEqual([]);
    const cbc = lineOf(draft, "lab-cbc");
    const decided = await service.decide(decide(draft, [{ lineId: cbc.id, decision: "approve" }, { lineId: lineOf(draft, "img-cxr").id, decision: "reject" }]), physician);
    const results = await service.chart(decided.id, physician, { write: true });
    expect(results).toEqual([{ itemKey: orderItemKey(cbc.id), item: cbc.id, resourceType: "ServiceRequest", status: "created", resourceId: "fic-created-1" }]);
    // Only the approved line was handed to the EHR, with the catalog's own code, as a service request.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "service_request", itemKey: orderItemKey(cbc.id), orderKind: "lab", display: "Complete blood count", code: { system: "urn:test", code: "CBC-1" } });
    expect(begun).toEqual([cbc.id]);
    expect([...rows.keys()]).toEqual([orderItemKey(cbc.id)]);
    // Writing again creates nothing more.
    expect((await service.chart(decided.id, physician, { write: true }))[0].status).toBe("created");
    expect(items).toHaveLength(1);
    // Reading never writes.
    expect(await service.chart(decided.id, physician)).toHaveLength(1);
    expect(items).toHaveLength(1);
  });

  it("is the physician's to write: a non-physician and a session without the chart permission cannot", async () => {
    const { writer, items } = writerThat(created);
    const { service, draft } = await drafted(all, { writer });
    const decided = await service.decide(decide(draft, [{ lineId: draft.lines[0].id, decision: "approve" }]), physician);
    for (const actor of [nurse, { ...physician, scopes: ["chart:read", "order:draft", "order:approve"] }, { ...physician, scopes: ["chart:read", "order:draft", "chart:write"] }]) {
      await expect(service.chart(decided.id, actor, { write: true })).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(items).toEqual([]);
  });

  it("writes a medication as a request with the catalog's product and dose, and records the acknowledgement and the reason with it", async () => {
    const { writer, items } = writerThat(created);
    const { service, draft } = await drafted(all, { writer });
    const amoxicillin = lineOf(draft, "med-amox");
    const decided = await service.decide(decide(draft, [{ lineId: amoxicillin.id, decision: "approve", acknowledged: ["allergy"], overrideReason: REASON }]), physician);
    const [result] = await service.chart(decided.id, physician, { write: true });
    expect(result).toMatchObject({ resourceType: "MedicationRequest", status: "created" });
    expect(items[0]).toMatchObject({ kind: "medication_request", display: "Amoxicillin 500 mg capsule", medication: { product: "Amoxicillin", dose: "500 mg", route: "oral", frequency: "every 8 hours", duration: "7 days" } });
    expect((items[0] as { physicianNote: string }).physicianNote).toBe(`Prepared with StethoLink and approved by the ordering physician. Acknowledged: allergy. Reason: ${REASON}`);
  });

  it("offers the order as text to enter when the EHR takes no such write, and again once it does", async () => {
    let accepts = false;
    const { writer, items } = writerThat((item, call) => accepts ? created(item, call) : { status: "unsupported", failure: `The EHR does not accept new ${RESOURCE_OF[item.kind]} records from applications` });
    const { service, draft } = await drafted(all, { writer });
    const decided = await service.decide(decide(draft, [{ lineId: lineOf(draft, "lab-cbc").id, decision: "approve" }, { lineId: lineOf(draft, "med-ibu").id, decision: "approve", acknowledged: ["interaction"], overrideReason: REASON }]), physician);
    const before = await service.chart(decided.id, physician, { write: true });
    expect(before.map((entry) => [entry.resourceType, entry.status])).toEqual([["ServiceRequest", "unsupported"], ["MedicationRequest", "unsupported"]]);
    expect(before.map((entry) => entry.copyText)).toEqual(["Laboratory: Complete blood count (CBC-1, urn:test)", "Medication: Ibuprofen, 400 mg, oral, every 8 hours"]);
    expect(before[0].failure).toContain("ServiceRequest");
    accepts = true;
    const after = await service.chart(decided.id, physician, { write: true });
    expect(after.map((entry) => entry.status)).toEqual(["created", "created"]);
    expect(after.every((entry) => entry.copyText === undefined)).toBe(true);
    expect(items).toHaveLength(4);
  });

  it("says the write is not switched on when this session has no writer, and keeps the text; a failure is reported and tried again later", async () => {
    const { service, draft } = await drafted(all, { writer: null });
    const decided = await service.decide(decide(draft, [{ lineId: lineOf(draft, "img-cxr").id, decision: "approve" }]), physician);
    const [result] = await service.chart(decided.id, physician, { write: true });
    expect(result).toMatchObject({ status: "unsupported", failure: "Writing to the chart is not switched on for this session", copyText: "Imaging: Chest X-ray, two views (CXR-2, urn:test)" });
    let calls = 0;
    const flaky = writerThat((item, call) => (calls = call) === 1 ? { status: "failed", failure: "The EHR could not be reached. Nothing was written" } : created(item, call));
    const second = await drafted(all, { writer: flaky.writer });
    const approved = await second.service.decide(decide(second.draft, [{ lineId: second.draft.lines[0].id, decision: "approve" }]), physician);
    expect((await second.service.chart(approved.id, physician, { write: true }))[0]).toMatchObject({ status: "failed", failure: expect.stringContaining("Nothing was written"), copyText: expect.any(String) });
    expect((await second.service.chart(approved.id, physician, { write: true }))[0]).toMatchObject({ status: "created" });
    expect(calls).toBe(2);
  });

  it("cannot write without a ledger, and cannot open one for an order that is not approved", async () => {
    const { service, draft } = await drafted(all, { noLedger: true });
    await expect(service.chart(draft.id, physician)).rejects.toMatchObject({ code: "not_implemented" });
    // The ledger double mirrors the database: asked for a pending line, it refuses.
    const repository = memoryOrderRepository();
    const { ledger } = memoryLedger(repository);
    repository.drafts.push(draft);
    await expect(ledger.begin("order", draft.lines[0].id, orderItemKey(draft.lines[0].id), "ServiceRequest")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("what is written and shown for an approved order", () => {
  const base: OrderLine = { id: "aaaaaaaa-0000-4000-8000-000000000001", catalogItemId: "lab-cbc", kind: "lab", display: "Complete blood count", basis: "requested", reason: "r", evidenceIds: [], flags: [], status: "approved" };
  it("derives the key from the line, so one line is one record", () => {
    expect(orderItemKey(base.id)).toBe("sl-ord-aaaaaaaa000040008000000000000001");
    expect(orderItemKey(base.id)).toMatch(/^[A-Za-z0-9.-]{8,64}$/);
  });
  it("leaves a code out when the catalog has none, and writes the kind of a nursing order", () => {
    expect(orderWriteItem({ ...base, kind: "nursing", display: "Vital signs every 4 hours" })).toEqual({ kind: "service_request", itemKey: orderItemKey(base.id), orderKind: "nursing", display: "Vital signs every 4 hours", physicianNote: "Prepared with StethoLink and approved by the ordering physician." });
    expect(orderCopyText({ ...base, kind: "nursing", display: "Vital signs every 4 hours" })).toBe("Nursing: Vital signs every 4 hours");
  });
  it("refuses a medication without its medication instead of writing a guess", () => {
    expect(() => orderWriteItem({ ...base, kind: "medication" })).toThrow(/without its medication/);
  });
});

describe("the model is asked once", () => {
  it("is not asked again to decide or to write", async () => {
    const generate = vi.fn(async () => ({ text: JSON.stringify({ mode: "specific", items: [line("lab-cbc", { requestedText: "CBC" })], unmatched: [] }), provider: "scripted", model: "scripted-1" }));
    const repository = memoryOrderRepository();
    const memory = memoryLedger(repository);
    const { writer } = writerThat(created);
    const service = createOrderService({ repository, provider: { name: "scripted", generate }, safety: clinicalSafetyGuard, adapter: orderChart().adapter, dataClassification: "live", catalog: ORDER_CATALOG, ledger: memory.ledger, writer });
    const draft = await service.create({ request: "Prepare a CBC", idempotencyKey: "one-model-call" }, physician) as OrderDraft;
    const decided = await service.decide(decide(draft, [{ lineId: draft.lines[0].id, decision: "approve" }]), physician);
    await service.chart(decided.id, physician, { write: true });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
