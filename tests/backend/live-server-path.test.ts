import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedLaunch } from "@/platform/auth/identity";
import type { ConsultationDraft } from "@/shared/contracts";
import type { ModelProvider, ModelRequest } from "@/core/agent/providers/types";
import { mockProvider } from "@/tests/fixtures/mock-provider";
import { completeSmartLaunch, fakeEhr, FAKE_EHR, smartEnv } from "../helpers/smart-launch";
import { citedEvidenceIds } from "@/shared/utils/referral-text";

/**
 * The server composition for a verified LIVE session, against a fake FHIR server, a fake
 * model and an in-memory store. Every patient, clinician and identifier is fictional.
 */
const { env, model, stored, repository, jar, handles } = vi.hoisted(() => {
  const stored: unknown[] = [];
  return {
    env: {} as Record<string, string | number | undefined>,
    model: { current: undefined as unknown },
    stored,
    jar: new Map<string, string>(),
    handles: new Map<string, { kind: string; payload: unknown; expiresAt: number }>(),
    repository: {
      get: vi.fn(async () => null), list: vi.fn(async () => []),
      create: vi.fn(async (draft: unknown) => { stored.push(draft); return draft; }),
      approve: vi.fn(async (input: unknown) => input),
    },
  };
});
vi.mock("@/platform/tenants/env", async (original) => ({ ...await original<typeof import("@/platform/tenants/env")>(), getEnv: () => env }));
vi.mock("@/platform/tenants/model-provider", () => ({ getModelProvider: () => model.current }));
vi.mock("@/platform/persistence", () => ({ createConsultationRepository: () => repository, createProviderResponseSink: () => ({ record: vi.fn() }) }));
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
const { getChat, getClinicalServices, getConsultations, requireClinician } = await import("@/apps/embedded-app/server");
const { GET: smartLaunch } = await import("@/apps/embedded-app/app/api/smart/launch/route");
const { GET: smartCallback } = await import("@/apps/embedded-app/app/api/smart/callback/route");
const FHIR = FAKE_EHR.fhir;
const TOKEN = FAKE_EHR.accessToken;
const live = {
  NODE_ENV: "production", TENANT_ID: "fictional-hospital",
  STETHOLINK_DATABASE_URL: "postgres://stetholink_runtime@db.example.test/postgres",
  AI_PROVIDER: "openai", MODEL_LIVE_DATA_APPROVED: "true", PROVIDER_TIMEOUT_MS: 1000,
};
let fhir: ReturnType<typeof vi.fn<typeof fetch>>;
/**
 * The session every test starts from is the one the signed SMART launch produced: the server
 * verified the ID token, mapped the clinician and granted the permissions. Nothing is hand-built.
 */
async function launched(role: "physician" | "clinician" = "physician"): Promise<VerifiedLaunch> {
  Object.assign(env, smartEnv(role));
  const ehr = await fakeEhr();
  fhir = vi.fn(ehr.request as typeof fetch);
  vi.stubGlobal("fetch", fhir);
  expect((await completeSmartLaunch({ launch: smartLaunch, callback: smartCallback }, ehr)).status).toBe(303);
  const verified = await requireClinician();
  fhir.mockClear();
  return verified;
}
/** A session that differs from what the launch granted, to check that each boundary holds on its own. */
const altered = (base: VerifiedLaunch, change: Partial<VerifiedLaunch["context"]>, source: VerifiedLaunch["source"] = base.source): VerifiedLaunch =>
  ({ ...base, source, ehrAccessToken: source === "smart" ? base.ehrAccessToken : undefined, context: { ...base.context, ...change } });
function fakeLiveModel() {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = { name: "fake-live-model", async generate(request) {
    requests.push(request);
    return { ...await mockProvider.generate({ ...request, dataClassification: undefined }), provider: "fake-live-model", model: "fake-live-1" };
  } };
  return { provider, requests };
}
const intent = { patientId: "fic-pt-1", encounterId: "fic-enc-1", specialty: "Cardiology", clinicalQuestion: "Is further work-up needed?" };

beforeEach(() => {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, live);
  stored.length = 0;
  jar.clear();
  handles.clear();
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("verified live session through the server composition (signed SMART launch, fake FHIR server)", () => {
  it("drafts from the real chart shape: every statement cites a FHIR record, pinned to the launched chart", async () => {
    const fake = fakeLiveModel();
    model.current = fake.provider;
    const session = await launched();
    const draft = await getConsultations(session).create({ patientId: "fic-pt-1", encounterId: "fic-enc-1", request: "Prepare a cardiology consultation about exertional chest pain and whether further work-up is needed" }) as ConsultationDraft;
    expect(draft).toMatchObject({ patientId: "fic-pt-1", encounterId: "fic-enc-1", status: "pending_approval" });
    expect(draft.grounding?.provenance).toMatchObject({ dataClassification: "live", provider: "fake-live-model" });
    expect(draft.grounding?.reason).toBe("Chest pain on exertion");
    expect(draft.grounding?.safetyFlags).not.toContain("insufficient_clinical_data");
    expect(stored).toHaveLength(1);
    expect(repository.approve).not.toHaveBeenCalled();
    // The draft cites facts from all four resource types, each with its EHR record as source.
    const cited = citedEvidenceIds(draft.summary).map((id) => draft.clinicalFacts!.find((fact) => fact.id === id)!);
    expect(cited.every((fact) => fact?.source.type === "fhir")).toBe(true);
    const citedTypes = new Set(cited.map((fact) => fact.source.reference.split("/")[0]));
    expect([...citedTypes].sort()).toEqual(["AllergyIntolerance", "Condition", "MedicationRequest", "Observation"]);
    expect(draft.summary).toContain("Penicillin");
    expect(draft.summary).toContain("Dose not recorded in the order");
    expect(draft.summary).toContain("Systolic blood pressure 152 mmHg");
    // What the connector did not load is stated in the draft for the physician.
    expect(draft.assessment).toContain("Older results are not included");
    // Every EHR read used the session's server-side token and stayed on the launched patient.
    expect(fhir.mock.calls.length).toBeGreaterThan(0);
    for (const [target] of fhir.mock.calls) {
      const url = new URL(String(target));
      expect(url.origin + "/fhir").toBe(FHIR);
      expect(url.pathname.endsWith("/fic-pt-1") || url.pathname.endsWith("/fic-enc-1") || url.searchParams.get("patient") === "fic-pt-1").toBe(true);
    }
    // The model saw a live-classified request with no name, birth date, chart identifiers or token.
    expect(fake.requests[0].dataClassification).toBe("live");
    const sent = JSON.stringify(fake.requests);
    for (const secret of ["Faisal", "Fictional-Example", "1970-01-01", "fic-pt-1", "fic-enc-1", "cond-htn", "rx-metformin", "obs-bp", TOKEN]) expect(sent).not.toContain(secret);
  });
  it("lets a non-physician draft but not approve, by the launch's own permissions", async () => {
    model.current = fakeLiveModel().provider;
    const nurse = await launched("clinician");
    await expect(getConsultations(nurse).create(intent)).resolves.toMatchObject({ status: "pending_approval" });
    const approval = { draftId: "d1", decision: "approve" as const, recipientId: "fictional-cardiology", expectedVersion: 1, idempotencyKey: "k1" };
    await expect(getConsultations(nurse).approve(approval)).rejects.toMatchObject({ code: "forbidden" });
    expect(repository.approve).not.toHaveBeenCalled();
  });
  it("refuses another patient or encounter than the launched one", async () => {
    model.current = fakeLiveModel().provider;
    const session = await launched();
    const consultations = getConsultations(session);
    await expect(consultations.create({ ...intent, patientId: "fic-pt-2" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(consultations.create({ ...intent, encounterId: "fic-enc-2" })).rejects.toMatchObject({ code: "forbidden" });
    const { patientContext } = getClinicalServices(session);
    expect(await patientContext.getContext("fic-pt-2")).toBeNull();
    expect(fhir).not.toHaveBeenCalled();
  });
  it("fails visibly when the configured model cannot take live data, and keeps free-text chat off", async () => {
    model.current = mockProvider;
    const session = await launched();
    await expect(getConsultations(session).create(intent)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(stored).toHaveLength(0);
    expect(() => getChat(session)).toThrow(expect.objectContaining({ code: "not_implemented" }));
  });
  it("keeps approval on the physician path and routing off until a live provider directory exists", async () => {
    model.current = fakeLiveModel().provider;
    const session = await launched();
    const approval = { draftId: "d1", decision: "approve" as const, recipientId: "fictional-cardiology", expectedVersion: 1, idempotencyKey: "k1" };
    await expect(getConsultations(altered(session, { roles: ["clinician"] })).approve(approval)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getConsultations(altered(session, { scopes: ["chart:read", "consultation:draft"] })).approve(approval)).rejects.toMatchObject({ code: "forbidden" });
    expect(repository.approve).not.toHaveBeenCalled();
    const consultations = getConsultations(session);
    await consultations.approve(approval);
    expect(repository.approve).toHaveBeenCalledWith(approval);
    // No simulated specialist exists: without a configured directory nothing can be sent anywhere.
    await expect(consultations.route("d1", { providerId: "synthetic-cardiology", expectedVersion: 2, idempotencyKey: "k2" })).rejects.toMatchObject({ code: "not_implemented" });
    expect(consultations).not.toHaveProperty("simulateSpecialist");
    repository.get.mockResolvedValueOnce({ id: "d1" } as never);
    expect(await consultations.providers("d1")).toEqual([]);
  });
  it("denies a session whose classification is not the tenant's", async () => {
    model.current = fakeLiveModel().provider;
    const session = await launched();
    // A synthetic-classified session is refused: this tenant reads a real EHR.
    expect(() => getConsultations(altered(session, { dataClassification: "synthetic" }))).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => getClinicalServices(altered(session, { dataClassification: "synthetic" }))).toThrow(expect.objectContaining({ code: "forbidden" }));
    // So is a session that carries no EHR grant, and one of another tenant.
    expect(() => getClinicalServices({ ...session, ehrAccessToken: undefined })).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => getClinicalServices(altered(session, { tenantId: "another-hospital" }))).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(fhir).not.toHaveBeenCalled();
  });
});
