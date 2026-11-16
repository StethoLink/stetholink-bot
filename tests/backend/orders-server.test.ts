import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedLaunch } from "@/platform/auth/identity";
import type { ModelProvider, ModelRequest } from "@/core/agent/providers/types";
import type { OrderCatalog, OrderDraft } from "@/shared/contracts";
import { orderDraftSchema, orderNoMatchSchema } from "@/shared/schemas";
import { ORDER_CATALOG, memoryOrderLedger, memoryOrderRepository } from "@/tests/fixtures/orders";
import { completeSmartLaunch, fakeEhr, FAKE_EHR, smartEnv } from "../helpers/smart-launch";

/**
 * Order drafting through the server composition for a verified LIVE session: the signed SMART launch, the fake FHIR server's chart,
 * a scripted model and an in-memory store. Every patient, clinician, order and identifier is fictional.
 */
const { env, model, calls, store, ledgerState, catalogState, jar, handles } = vi.hoisted(() => ({
  env: {} as Record<string, string | number | undefined>,
  model: { current: undefined as unknown },
  calls: [] as Array<{ task: unknown; sessionKey: string }>,
  store: { current: undefined as unknown },
  ledgerState: { current: undefined as unknown },
  catalogState: { current: null as unknown },
  jar: new Map<string, string>(),
  handles: new Map<string, { kind: string; payload: unknown; expiresAt: number }>(),
}));
vi.mock("@/platform/tenants/env", async (original) => ({ ...await original<typeof import("@/platform/tenants/env")>(), getEnv: () => env }));
vi.mock("@/platform/tenants/model-provider", () => ({ getModelProvider: (privacy: { sessionKey: string }, task: unknown) => { calls.push({ task, sessionKey: privacy.sessionKey }); return model.current; } }));
vi.mock("@/platform/tenants/order-catalog", () => ({ getOrderCatalog: () => catalogState.current }));
vi.mock("@/platform/persistence", () => ({ createConsultationRepository: () => ({}), createProviderResponseSink: () => ({ record: vi.fn() }) }));
vi.mock("@/platform/persistence/orders", () => ({ createOrderRepository: () => store.current }));
vi.mock("@/platform/persistence/scribe", () => ({ createChartWriteLedger: () => ledgerState.current }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (key: string) => ({ value: jar.get(key) }), set: (key: string, value: string) => jar.set(key, value),
}), headers: async () => new Headers({ host: "app.example.test" }) }));
vi.mock("@/platform/auth/session-store", () => ({
  sessionCookie: "session", launchCookie: "launch",
  storeHandle: async (kind: string, payload: unknown, expiresAt: number) => {
    const key = crypto.randomUUID();
    handles.set(key, { kind, payload, expiresAt });
    return key;
  },
  readHandle: async (key: string, kind: string, consume: boolean) => {
    const entry = handles.get(key);
    if (!entry || entry.kind !== kind || entry.expiresAt <= Date.now()) return undefined;
    if (consume) handles.delete(key);
    return entry.payload;
  },
}));
const { requireClinician } = await import("@/apps/embedded-app/server");
const { getOrders } = await import("@/apps/embedded-app/server/orders");
const { GET: smartLaunch } = await import("@/apps/embedded-app/app/api/smart/launch/route");
const { GET: smartCallback } = await import("@/apps/embedded-app/app/api/smart/callback/route");
const live = { NODE_ENV: "production", TENANT_ID: "fictional-hospital", STETHOLINK_DATABASE_URL: "postgres://stetholink_runtime@db.example.test/postgres", AI_PROVIDER: "openai", MODEL_LIVE_DATA_APPROVED: "true" };

async function launched(role: "physician" | "clinician" = "physician"): Promise<VerifiedLaunch> {
  Object.assign(env, smartEnv(role));
  const ehr = await fakeEhr();
  vi.stubGlobal("fetch", vi.fn(ehr.request as typeof fetch));
  expect((await completeSmartLaunch({ launch: smartLaunch, callback: smartCallback }, ehr)).status).toBe(303);
  return requireClinician();
}
const altered = (base: VerifiedLaunch, change: Partial<VerifiedLaunch["context"]>): VerifiedLaunch => ({ ...base, context: { ...base.context, ...change } });

/** A model that picks the catalog orders whose name appears in the request and cites the first documented fact it was sent for a proposal. */
function pickingModel() {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    name: "picking",
    async generate(request) {
      requests.push(request);
      const input = JSON.parse(request.messages[0].content) as { request: string; chart: { facts: Array<{ id: string; status: string }> }; catalog: OrderCatalog };
      const wanted = input.catalog.items.filter((item) => [item.display, ...item.synonyms].some((name) => input.request.toLowerCase().includes(name.toLowerCase())));
      const fact = input.chart.facts.find((entry) => entry.status === "known");
      const items = wanted.map((item) => ({ itemId: item.id, requestedText: "", reason: "Requested by the physician.", evidenceIds: fact ? [fact.id] : [] }));
      return { text: JSON.stringify({ mode: items.length ? "specific" : "unclear", items, unmatched: items.length ? [] : [input.request] }), provider: "picking", model: "picking-1" };
    },
  };
  return { provider, requests };
}

beforeEach(() => {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, live);
  jar.clear(); handles.clear(); calls.length = 0;
  store.current = memoryOrderRepository();
  ledgerState.current = memoryOrderLedger(store.current as ReturnType<typeof memoryOrderRepository>).ledger;
  catalogState.current = ORDER_CATALOG;
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("order drafting for a verified live session", () => {
  it("drafts from the launched chart through the de-identified model client, and stores only pending lines", async () => {
    const fake = pickingModel();
    model.current = fake.provider;
    const session = await launched();
    const result = await getOrders(session).create({ request: "Prepare a CBC and amoxicillin for this patient", idempotencyKey: "k-1" });
    const draft = orderDraftSchema.parse(result);
    expect(draft).toMatchObject({ patientId: "fic-pt-1", encounterId: "fic-enc-1", mode: "specific", catalogVersion: "test-1" });
    expect(draft.provenance.dataClassification).toBe("live");
    expect(draft.lines.map((line) => [line.catalogItemId, line.status])).toEqual([["lab-cbc", "pending"], ["med-amox", "pending"]]);
    // The only way a model client is built, for the orders task, with the session's privacy context.
    expect(calls).toEqual([{ task: "order_drafting", sessionKey: expect.stringContaining("fic-pt-1") }]);
    expect(fake.requests[0].dataClassification).toBe("live");
    expect(fake.requests[0].structuredOutput?.name).toBe("order_drafting");
    // The chart is the launched patient's own: its penicillin allergy flags the amoxicillin, citing the EHR's record.
    const amoxicillin = draft.lines.find((line) => line.catalogItemId === "med-amox")!;
    expect(amoxicillin.flags).toEqual([expect.objectContaining({ kind: "allergy", evidenceIds: [expect.any(String)] })]);
    const cited = draft.clinicalFacts.find((fact) => fact.id === amoxicillin.flags[0].evidenceIds[0])!;
    expect(cited).toMatchObject({ category: "allergy", status: "known", source: { type: "fhir" } });
    expect(cited.label).toContain("Penicillin");
    // What the model was sent held no name, chart identifier or token.
    const sent = JSON.stringify(fake.requests);
    for (const secret of ["Faisal", "Fictional-Example", "1970-01-01", "fic-pt-1", "fic-enc-1", FAKE_EHR.accessToken, "CBC-1", "every 8 hours"]) expect(sent, secret).not.toContain(secret);
    // The store holds the draft, found again by the same session.
    expect(await getOrders(session).get(draft.id)).toEqual(draft);
    expect(await getOrders(session).list()).toEqual([expect.objectContaining({ id: draft.id, lines: 2, pending: 2 })]);
  });

  it("answers no_match for a request the catalog cannot serve, and logs identifiers only", async () => {
    model.current = pickingModel().provider;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const session = await launched();
    const result = await getOrders(session).create({ request: "an MRI of the knee for Faisal", idempotencyKey: "k-2" });
    expect(orderNoMatchSchema.parse(result)).toMatchObject({ outcome: "no_match", unmatched: ["an MRI of the knee for Faisal"] });
    expect((store.current as ReturnType<typeof memoryOrderRepository>).drafts).toHaveLength(0);
    const logged = info.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("orders.draft_no_match");
    for (const text of ["MRI", "knee", "Faisal", "Fictional"]) expect(logged, text).not.toContain(text);
  });

  it("lets a clinician who is not a physician draft: the launch gives them the drafting permission and not the approving one", async () => {
    model.current = pickingModel().provider;
    const nurse = await launched("clinician");
    expect(nurse.context.scopes).toContain("order:draft");
    expect(nurse.context.scopes).not.toContain("order:approve");
    expect(orderDraftSchema.parse(await getOrders(nurse).create({ request: "Prepare a CBC", idempotencyKey: "k-3" })).lines).toHaveLength(1);
    const physician = await launched("physician");
    expect(physician.context.scopes).toEqual(expect.arrayContaining(["order:draft", "order:approve"]));
  });

  it("is not offered without the hospital's catalog, and not to a session that is not the tenant's visit", async () => {
    model.current = pickingModel().provider;
    const session = await launched();
    catalogState.current = null;
    for (const call of [() => getOrders(session)]) expect(call).toThrow(expect.objectContaining({ code: "not_implemented", message: expect.stringContaining("not set up") }));
    catalogState.current = ORDER_CATALOG;
    expect(() => getOrders(altered(session, { tenantId: "another-hospital" }))).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => getOrders(altered(session, { encounterId: undefined }))).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => getOrders(altered(session, { scopes: ["order:draft"] }))).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => getOrders(altered(session, { dataClassification: "synthetic" }))).toThrow(expect.objectContaining({ code: "forbidden" }));
    // A session without the drafting permission can neither draft nor read.
    const noPermission = getOrders(altered(session, { scopes: ["chart:read"] }));
    await expect(noPermission.create({ request: "Prepare a CBC", idempotencyKey: "k-4" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(noPermission.list()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a model that cannot take live data instead of drafting without it", async () => {
    model.current = { name: "refusing", generate: async () => { throw Object.assign(new Error("not approved"), { code: "provider_unavailable" }); } } satisfies ModelProvider & { generate: () => Promise<never> };
    const session = await launched();
    await expect(getOrders(session).create({ request: "Prepare a CBC", idempotencyKey: "k-5" })).rejects.toThrow("not approved");
    expect((store.current as ReturnType<typeof memoryOrderRepository>).drafts).toHaveLength(0);
  });
});

const repositoryOf = () => store.current as ReturnType<typeof memoryOrderRepository>;
const REASON = "The patient tolerated it before; the benefit outweighs the risk.";
/** What was sent to the EHR's FHIR server with POST (the launch itself posts to the token endpoint, which is not a write). */
const posts = () => vi.mocked(globalThis.fetch).mock.calls.filter(([target, init]) => init?.method === "POST" && String(target).startsWith(FAKE_EHR.fhir));

describe("approving orders is the physician's, and writing them is the physician's too", () => {
  it("refuses a clinician who is not a physician, from the permissions of the signed launch, and records nothing", async () => {
    model.current = pickingModel().provider;
    const nurse = await launched("clinician");
    const draft = orderDraftSchema.parse(await getOrders(nurse).create({ request: "Prepare a CBC", idempotencyKey: "k-nurse" }));
    const decision = { draftId: draft.id, expectedVersion: draft.version, idempotencyKey: "d-nurse", decisions: [{ lineId: draft.lines[0].id, decision: "approve" as const }] };
    await expect(getOrders(nurse).decide(decision)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getOrders(nurse).writeToChart(draft.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(repositoryOf().decisions).toEqual([]);
    expect(repositoryOf().drafts[0].lines[0].status).toBe("pending");
  });

  it("lets the launched physician decide, logging counts only, and writes nothing for what is not approved", async () => {
    model.current = pickingModel().provider;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const session = await launched();
    const orders = getOrders(session);
    const draft = orderDraftSchema.parse(await orders.create({ request: "Prepare a CBC and amoxicillin for this patient", idempotencyKey: "k-doc" }));
    const [cbc, amoxicillin] = draft.lines;
    // Nothing is approved: the chart list is empty and nothing is written, with or without the write.
    expect(await orders.chart(draft.id)).toEqual([]);
    expect(await orders.writeToChart(draft.id)).toEqual([]);
    expect(posts()).toEqual([]);
    // The documented penicillin allergy has to be acknowledged, with a reason.
    await expect(orders.decide({ draftId: draft.id, expectedVersion: 1, idempotencyKey: "d-1", decisions: [{ lineId: amoxicillin.id, decision: "approve" }] })).rejects.toMatchObject({ code: "invalid_request" });
    const decided = orderDraftSchema.parse(await orders.decide({ draftId: draft.id, expectedVersion: 1, idempotencyKey: "d-2", decisions: [
      { lineId: cbc.id, decision: "approve" }, { lineId: amoxicillin.id, decision: "reject" }] }));
    expect(decided.lines.map((line) => line.status)).toEqual(["approved", "rejected"]);
    expect(decided.lines[0].decidedBy).toBe(FAKE_EHR.clinicianId);
    const logged = info.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain('"action":"orders.decided"');
    expect(logged).toContain('"approved":1');
    for (const text of ["CBC", "amoxicillin", "Penicillin", "Faisal", REASON]) expect(logged, text).not.toContain(text);
    // The list of approved orders carries the text to enter; reading it writes nothing.
    expect(await orders.chart(draft.id)).toEqual([expect.objectContaining({ item: cbc.id, resourceType: "ServiceRequest", status: "pending", copyText: expect.stringContaining("Complete blood count") })]);
    expect(posts()).toEqual([]);
  });

  it("offers the approved order as text when this session has no writer, or the EHR did not grant the create scope", async () => {
    model.current = pickingModel().provider;
    const session = await launched();
    const orders = getOrders(session);
    const draft = orderDraftSchema.parse(await orders.create({ request: "Prepare a CBC", idempotencyKey: "k-text" }));
    await orders.decide({ draftId: draft.id, expectedVersion: 1, idempotencyKey: "d-text", decisions: [{ lineId: draft.lines[0].id, decision: "approve" }] });
    // Write-back is switched off (the default): the order is offered as text.
    expect((await orders.writeToChart(draft.id))[0]).toMatchObject({ status: "unsupported", failure: "Writing to the chart is not switched on for this session", copyText: expect.stringContaining("Complete blood count") });
    // Switched on, but the launch did not grant ServiceRequest.c: still nothing is sent to the EHR.
    env.EHR_WRITE_ENABLED = "true";
    const written = await getOrders(session).writeToChart(draft.id);
    expect(written[0]).toMatchObject({ resourceType: "ServiceRequest", status: "unsupported", failure: expect.stringContaining("did not give StethoLink permission") });
    expect(posts()).toEqual([]);
  });
});

describe("what a stored draft is", () => {
  it("is returned by the contract and nothing else (no extra field reaches the browser)", async () => {
    model.current = pickingModel().provider;
    const session = await launched();
    const draft = await getOrders(session).create({ request: "Prepare a CBC", idempotencyKey: "k-6" }) as OrderDraft;
    expect(Object.keys(draft).sort()).toEqual(Object.keys(orderDraftSchema.parse(draft)).sort());
  });
});
