import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedLaunch } from "@/platform/auth/identity";
import type { ConsultationDraft } from "@/shared/contracts";
import type { ModelProvider, ModelRequest } from "@/core/agent/providers/types";
import { mockProvider } from "@/core/agent/providers/mock-provider";

/**
 * The server composition for a verified LIVE session, against a fake FHIR server, a fake
 * model and an in-memory store. Every patient, clinician and identifier is fictional.
 */
const { env, model, stored, repository } = vi.hoisted(() => {
  const stored: unknown[] = [];
  return {
    env: {} as Record<string, string | number | undefined>,
    model: { current: undefined as unknown },
    stored,
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
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }), headers: async () => new Headers() }));

const { getChat, getClinicalServices, getConsultations } = await import("@/apps/embedded-app/server");

const FHIR = "https://ehr.example.test/fhir";
const TOKEN = "fictional-ehr-access-token";
const live = {
  NODE_ENV: "production", TENANT_ID: "fictional-hospital", AUTH_MODE: "smart", CLINICAL_DATA_SOURCE: "fhir", CLINICAL_DATA_MODE: "live",
  FHIR_BASE_URL: FHIR, MOCK_RECIPIENT_IDS: "synthetic-cardiology", STETHOLINK_DATABASE_URL: "postgres://stetholink_runtime@db.example.test/postgres",
  AI_PROVIDER: "openai", MODEL_LIVE_DATA_APPROVED: "true", PROVIDER_TIMEOUT_MS: 1000, LOCAL_SYNTHETIC_CHART: "alpha",
};
const session = (change: Partial<VerifiedLaunch["context"]> = {}, source: VerifiedLaunch["source"] = "smart"): VerifiedLaunch => ({
  source, ehrAccessToken: source === "smart" ? TOKEN : undefined,
  context: {
    clinicianId: "55555555-5555-4555-8555-555555555555", tenantId: "fictional-hospital", roles: ["physician"],
    scopes: ["chart:read", "consultation:draft", "consultation:approve", "consultation:route"], patientId: "fic-pt-1", encounterId: "fic-enc-1",
    expiresAt: Date.now() + 600_000, authorization: "active", dataClassification: "live", ...change,
  },
});
/** Fake FHIR server for one fictional patient. */
const fhir = vi.fn(async (target: URL | string | Request, init?: RequestInit) => {
  const url = new URL(String(target));
  if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 });
  if (url.pathname === "/fhir/Patient/fic-pt-1") return Response.json({ resourceType: "Patient", id: "fic-pt-1", name: [{ text: "Omar Fictional-Example" }], gender: "male", birthDate: "1970-01-01" });
  if (url.pathname === "/fhir/Encounter/fic-enc-1") return Response.json({ resourceType: "Encounter", id: "fic-enc-1", subject: { reference: "Patient/fic-pt-1" }, class: { code: "AMB" }, status: "in-progress", period: { start: "2026-03-02T09:00:00Z" } });
  if (url.pathname === "/fhir/Condition") return Response.json({ resourceType: "Bundle", entry: [{ resource: { resourceType: "Condition", id: "c1", subject: { reference: "Patient/fic-pt-1" }, code: { text: "Hypertension" } } }] });
  if (["/fhir/AllergyIntolerance", "/fhir/MedicationRequest"].includes(url.pathname)) return Response.json({ resourceType: "Bundle", entry: [] });
  return new Response(null, { status: 404 });
});
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
  vi.stubGlobal("fetch", fhir);
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("verified live session through the server composition (fake FHIR server)", () => {
  it("drafts for a live session through the same path, pinned to the launched chart", async () => {
    const fake = fakeLiveModel();
    model.current = fake.provider;
    const draft = await getConsultations(session()).create(intent) as ConsultationDraft;
    expect(draft).toMatchObject({ patientId: "fic-pt-1", encounterId: "fic-enc-1", status: "pending_approval" });
    expect(draft.grounding?.provenance).toMatchObject({ dataClassification: "live", provider: "fake-live-model" });
    expect(draft.summary.split("\n")[0]).toBe("Consultation draft; physician review required.");
    expect(stored).toHaveLength(1);
    expect(repository.approve).not.toHaveBeenCalled();
    // Every EHR read used the session's server-side token and stayed on the launched patient.
    expect(fhir.mock.calls.length).toBeGreaterThan(0);
    for (const [target] of fhir.mock.calls) {
      const url = new URL(String(target));
      expect(url.origin + "/fhir").toBe(FHIR);
      expect(url.pathname.endsWith("/fic-pt-1") || url.pathname.endsWith("/fic-enc-1") || url.searchParams.get("patient") === "fic-pt-1").toBe(true);
    }
    // The model saw a live-classified request with no demographics, identifiers or token.
    expect(fake.requests[0].dataClassification).toBe("live");
    const sent = JSON.stringify(fake.requests);
    for (const secret of ["Omar", "1970-01-01", "fic-pt-1", "fic-enc-1", TOKEN]) expect(sent).not.toContain(secret);
    // The FHIR connector does not yet normalize chart resources into clinical facts, so the draft says so.
    expect(draft.grounding?.safetyFlags).toContain("insufficient_clinical_data");
  });

  it("refuses another patient or encounter than the launched one", async () => {
    model.current = fakeLiveModel().provider;
    const consultations = getConsultations(session());
    await expect(consultations.create({ ...intent, patientId: "fic-pt-2" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(consultations.create({ ...intent, encounterId: "fic-enc-2" })).rejects.toMatchObject({ code: "forbidden" });
    const { patientContext } = getClinicalServices(session());
    expect(await patientContext.getContext("fic-pt-2")).toBeNull();
    expect(fhir).not.toHaveBeenCalled();
  });

  it("fails visibly when the configured model cannot take live data", async () => {
    model.current = mockProvider;
    await expect(getConsultations(session()).create(intent)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(stored).toHaveLength(0);
    await expect(getChat(session()).handle({ message: "Summarise the chart", patientId: "fic-pt-1" })).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("keeps approval on the physician path and routing off until a live provider directory exists", async () => {
    model.current = fakeLiveModel().provider;
    const approval = { draftId: "d1", decision: "approve" as const, recipientId: "fictional-cardiology", expectedVersion: 1, idempotencyKey: "k1" };
    await expect(getConsultations(session({ roles: ["clinician"] })).approve(approval)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getConsultations(session({ scopes: ["chart:read", "consultation:draft"] })).approve(approval)).rejects.toMatchObject({ code: "forbidden" });
    expect(repository.approve).not.toHaveBeenCalled();
    const consultations = getConsultations(session());
    await consultations.approve(approval);
    expect(repository.approve).toHaveBeenCalledWith(approval);
    // The simulated specialists are never offered to, or reachable from, a live session.
    await expect(consultations.route("d1", { providerId: "synthetic-cardiology", expectedVersion: 2, idempotencyKey: "k2" })).rejects.toMatchObject({ code: "not_implemented" });
    await expect(consultations.simulateSpecialist("d1")).rejects.toMatchObject({ code: "not_implemented" });
    repository.get.mockResolvedValueOnce({ id: "d1" } as never);
    expect(await consultations.providers("d1")).toEqual([]);
  });

  it("keeps an EHR launch read-only on a tenant that is not configured for live data", async () => {
    env.CLINICAL_DATA_MODE = "synthetic";
    model.current = fakeLiveModel().provider;
    const sandbox = session({ dataClassification: "synthetic" });
    expect(() => getConsultations(sandbox)).toThrow(expect.objectContaining({ code: "forbidden", message: expect.stringContaining("CLINICAL_DATA_MODE") }));
    expect(() => getChat(sandbox)).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(await getClinicalServices(sandbox).patientContext.getContext("fic-pt-1")).toMatchObject({ patientId: "fic-pt-1", source: "fhir" });
    expect(stored).toHaveLength(0);
  });

  it("denies a session whose classification is not the tenant's", async () => {
    model.current = fakeLiveModel().provider;
    // A synthetic-classified session in a live tenant, whatever its source.
    expect(() => getConsultations(session({ dataClassification: "synthetic" }))).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => getClinicalServices(session({ dataClassification: "synthetic" }, "synthetic"))).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => getClinicalServices(session({}, "synthetic"))).toThrow(expect.objectContaining({ code: "forbidden" }));
    // A live-classified session in a synthetic tenant.
    env.CLINICAL_DATA_MODE = "synthetic";
    expect(() => getClinicalServices(session())).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => getChat(session())).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(fhir).not.toHaveBeenCalled();
  });
});
